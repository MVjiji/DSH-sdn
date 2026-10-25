/**
 * dsh-sandrone 的浏览器（Client）半侧。
 *
 * 两件事：
 *
 *   1. **设置页**（`settings.section` → 「桑多涅」）：开关、音量、语速，以及
 *      GPT-SoVITS 链路的参数与试听。读写都走 `ctx.configForms.get("sandrone")`，
 *      与宿主同一个命名空间 —— 也就是说这里改的值，宿主下一次合成立刻用上。
 *   2. **每轮回复结束的自动朗读**：挂在 `conversation.chat.turnTail`（一个 Turn 完成后
 *      渲染一次的位置），从会话的 chat 快照里取最后一条 assistant 文本，切成短句，
 *      逐句请求宿主 `/sandrone/tts` 并播放。
 *
 * 为什么不从 DOM 里抠文字：聊天视图的节点是结构化数据（`legacy.nodes`），
 * 文本、角色、是否流式都在里面。抠 DOM 会在主题/折叠/代码块上到处翻车。
 */
window.__ModuleLoader__.load({
  id: "dsh-sandrone",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useMemo, useState } = React;

    /** 设置命名空间 = 宿主那条 loader 条目的 id。 */
    const NS = "sandrone";

    /**
     * 客户端侧默认值 —— 与 lib/fields.js 保持一致。
     * 浏览器 bundle 不能 import 宿主那份模块，只能内联。
     */
    const DEFAULTS = {
      enabled: true,
      autoSpeak: true,
      presetOnly: true,
      volume: 100,
      speed: 1,
      textLang: "zh",
      chunkChars: 110,
      toneAuto: true,
      fixedTone: "neutral",
      apiUrl: "http://127.0.0.1:9880",
      gptDir: "D:\\GPT-SoVITS-v2pro-20250604",
      pythonPath: "",
      autoStart: true,
      preload: true,
      refAudio: "",
      promptText: "死亡不过是一个平静的等号，而他现在去了公式的右边。",
      promptLang: "zh",
    };

    /** 语气目录 —— 与宿主 `lib/tones.js` 保持一致；只用于设置页下拉和兜底。 */
    const TONES = [
      { id: "neutral", label: "平静" },
      { id: "tease", label: "揶揄" },
      { id: "annoyed", label: "嫌烦" },
      { id: "angry", label: "冷淡" },
      { id: "soft", label: "别扭" },
      { id: "serious", label: "认真" },
    ];
    const TONE_NAME = new Map(TONES.map((tone) => [tone.id, tone.label]));
    const FALLBACK_TONE = "neutral";

    /* ══════════════════════════════════════════════════════════════
     * 设置读取
     * ══════════════════════════════════════════════════════════════ */

    /** 把 configForms 快照归一化成一份完整设置。 */
    /** 把一个 configForms 快照包成 `valuesOf` 认识的最小形态。 */
    function formOf(snapshot) {
      return { getSnapshot: () => snapshot };
    }

    function valuesOf(form) {
      let raw = {};
      try {
        raw = form?.getSnapshot?.()?.value ?? {};
      } catch {
        raw = {};
      }
      const out = {};
      for (const key of Object.keys(DEFAULTS)) {
        const value = raw?.[key];
        out[key] = value === undefined || value === null ? DEFAULTS[key] : value;
      }
      // 旧配置里的 auto 已经不再生效：中文正文固定按 zh 合成，避免判成日/英。
      if (out.textLang !== "zh" && out.textLang !== "ja" && out.textLang !== "en") {
        out.textLang = "zh";
      }
      return out;
    }

    /**
     * 请宿主按整条回复挑一组语气参考。
     *
     * 放在宿主做，是为了让「哪组参考 wav + 哪段逐字文本」只有一份真相；
     * 浏览器只拿一个 tone id，再逐句带上。失败就退 neutral，不挡朗读。
     */
    async function pickToneFor(sessionId, text) {
      try {
        // 只拿开头一段去判语气：URL 放不下整篇长回复，而开场用词已经足够代表这一轮。
        const sample = String(text ?? "").slice(0, 1000);
        const res = await fetch(
          `/sandrone/tone?text=${encodeURIComponent(sample)}&sessionId=${encodeURIComponent(sessionId ?? "")}`,
          { cache: "no-store" },
        );
        if (!res.ok) return FALLBACK_TONE;
        const data = await res.json();
        return typeof data?.tone === "string" && TONE_NAME.has(data.tone)
          ? data.tone
          : FALLBACK_TONE;
      } catch {
        return FALLBACK_TONE;
      }
    }

    /* ══════════════════════════════════════════════════════════════
     * 朗读引擎
     * ══════════════════════════════════════════════════════════════ */

    /** 当前正在播的 Audio；换一句或停止时先 pause。 */
    let activeAudio = null;
    /** 每次新的朗读 +1，用来让还在飞行的请求作废。 */
    let generation = 0;
    /** 是否正在念（给按钮用）。 */
    let speaking = false;
    const speakingSubs = new Set();

    function setSpeaking(next) {
      speaking = next;
      for (const cb of speakingSubs) {
        try {
          cb(next);
        } catch {
          /* 单个订阅者出错不影响别人 */
        }
      }
    }

    function useSpeaking() {
      const [value, setValue] = useState(speaking);
      useEffect(() => {
        speakingSubs.add(setValue);
        setValue(speaking);
        return () => speakingSubs.delete(setValue);
      }, []);
      return value;
    }

    /** 停掉当前朗读（并让还在排队的句子作废）。 */
    function stopSpeech() {
      generation += 1;
      const audio = activeAudio;
      activeAudio = null;
      if (audio !== null) {
        try {
          audio.pause();
        } catch {
          /* 已经结束的 Audio 再 pause 会抛，忽略 */
        }
      }
      setSpeaking(false);
    }

    /** 播一段 wav，结束后 resolve；被 stopSpeech 打断时也会 resolve。 */
    function playBlob(blob, volume) {
      return new Promise((resolve) => {
        let url = "";
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (url !== "") {
            try {
              URL.revokeObjectURL(url);
            } catch {
              /* 已经回收过 */
            }
          }
          if (activeAudio === audio) activeAudio = null;
          resolve();
        };
        const audio = new Audio();
        try {
          url = URL.createObjectURL(blob);
        } catch {
          finish();
          return;
        }
        audio.src = url;
        audio.volume = Math.max(0, Math.min(1, Number(volume) / 100 || 0));
        audio.onended = finish;
        audio.onerror = finish;
        audio.onpause = finish;
        activeAudio = audio;
        const played = audio.play();
        if (played !== undefined && typeof played.catch === "function") played.catch(finish);
      });
    }

    /** 去掉不该念出来的东西：代码块、链接、Markdown 记号、HTML 标签。 */
    function cleanForSpeech(raw) {
      let text = String(raw ?? "");
      text = text.replace(/```[\s\S]*?```/g, "。");
      text = text.replace(/`[^`]*`/g, "");
      text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
      text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      text = text.replace(/<[^>]*>/g, "");
      text = text.replace(/https?:\/\/\S+/g, "");
      text = text.replace(/^\s{0,3}#{1,6}\s*/gm, "");
      text = text.replace(/^\s*[-*+]\s+/gm, "");
      text = text.replace(/^\s*>\s?/gm, "");
      text = text.replace(/[*_~]{1,3}/g, "");
      text = text.replace(/[ \t]+/g, " ");
      text = text.replace(/\n{2,}/g, "\n");
      return text.trim();
    }

    /** 把一段话切成适合逐句合成的短块（首句越快出声越好）。 */
    function splitForSpeech(raw, chunkChars) {
      const limit = Math.max(30, Math.min(400, Number(chunkChars) || 110));
      const text = String(raw ?? "").trim();
      if (text === "") return [];
      const pieces = text.split(/(?<=[。！？!?；;…\n])/);
      const out = [];
      let buffer = "";
      const flush = () => {
        const line = buffer.trim();
        if (line !== "") out.push(line);
        buffer = "";
      };
      for (const piece of pieces) {
        if (piece === "") continue;
        if (buffer.length + piece.length <= limit) {
          buffer += piece;
          continue;
        }
        flush();
        if (piece.length <= limit) {
          buffer = piece;
          continue;
        }
        let rest = piece;
        while (rest.length > limit) {
          let cut = -1;
          for (const mark of ["，", "、", ",", " "]) {
            const at = rest.lastIndexOf(mark, limit);
            if (at > cut) cut = at;
          }
          if (cut <= 0) cut = limit;
          const head = rest.slice(0, cut + 1).trim();
          if (head !== "") out.push(head);
          rest = rest.slice(cut + 1);
        }
        buffer = rest;
      }
      flush();
      return out;
    }

    /**
     * 念一段文本。
     *
     * @param {string} sessionId - 会话 id（宿主用它做预设门禁）。
     * @param {string} text - 要念的文本。
     * @param {object | null} form - configForms 表单（读当前设置）。
     * @returns {Promise<boolean>} 是否至少念出了一句。
     */
    async function speakText(sessionId, text, form) {
      const values = valuesOf(form);
      if (values.enabled !== true) return false;
      const body = cleanForSpeech(text);
      if (body === "") return false;

      stopSpeech();
      const token = generation;
      const chunks = splitForSpeech(body, values.chunkChars);
      if (chunks.length === 0) return false;

      // 语气按「整条回复」定一次，逐句沿用同一组参考，避免一句一个音色。
      const fixed = TONE_NAME.has(values.fixedTone) ? values.fixedTone : FALLBACK_TONE;
      let tone = fixed;
      if (values.toneAuto === true) {
        tone = await pickToneFor(sessionId, body);
        if (token !== generation) return false;
      }

      setSpeaking(true);
      let spoke = false;
      try {
        for (const chunk of chunks) {
          if (token !== generation) return spoke;
          let res;
          try {
            res = await fetch(
              `/sandrone/tts?sessionId=${encodeURIComponent(sessionId ?? "")}&tone=${encodeURIComponent(tone)}&text=${encodeURIComponent(chunk)}`,
              { method: "POST" },
            );
          } catch {
            return spoke;
          }
          if (token !== generation) return spoke;
          if (!res.ok) {
            try {
              const info = await res.json();
              console.log(`[dsh-sandrone] 跳过朗读：${info?.message ?? res.status}`);
            } catch {
              console.log(`[dsh-sandrone] 跳过朗读：HTTP ${res.status}`);
            }
            return spoke;
          }
          let blob;
          try {
            blob = await res.blob();
          } catch {
            return spoke;
          }
          if (token !== generation) return spoke;
          await playBlob(blob, values.volume);
          spoke = true;
          if (token !== generation) return spoke;
        }
        return spoke;
      } finally {
        if (token === generation) setSpeaking(false);
      }
    }

    /* ══════════════════════════════════════════════════════════════
     * 「哪一轮该自动念」的判定
     * ══════════════════════════════════════════════════════════════ */

    /**
     * 打开一个老会话时，历史 Turn 会一次性全部挂载。判定「这轮该不该念」靠两条：
     *
     *   1. **时间**：最后一条回复的时间距现在不超过 2 分钟 —— 老会话的历史回复都是旧的，
     *      自然跳过；新会话的第一条回复刚写完，一定在这个窗口里。
     *   2. **水位**：同一个 Turn 只念一次（`seq` 是 Turn 的收尾序号），滚动来回不会重播。
     */
    const FRESH_MS = 120_000;
    const sessionWatermark = new Map();

    function shouldAutoSpeak(sessionId, seq, time) {
      const key = String(sessionId ?? "");
      let state = sessionWatermark.get(key);
      if (state === undefined) {
        state = { spokenSeq: -1, seen: false };
        sessionWatermark.set(key, state);
      }
      if (seq <= state.spokenSeq) return false;

      const stamp = typeof time === "number" ? time : Number.NaN;
      if (!Number.isFinite(stamp)) {
        // 拿不到时间戳：退化成「这个会话见过一次之后才出声」，宁可晚一轮也不念历史。
        const first = state.seen !== true;
        state.seen = true;
        state.spokenSeq = Math.max(state.spokenSeq, seq);
        return !first;
      }
      state.seen = true;
      if (Date.now() - stamp > FRESH_MS) {
        state.spokenSeq = Math.max(state.spokenSeq, seq);
        return false;
      }
      state.spokenSeq = seq;
      return true;
    }

    /** 取最后一条 assistant 的正文与时间。 */
    function latestAssistant(nodes) {
      if (!Array.isArray(nodes)) return { text: "", time: undefined };
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i];
        if (node?.kind !== "assistant") continue;
        const raw = (node.blocks ?? [])
          .filter((block) => block?.kind === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("");
        const text = cleanForSpeech(raw);
        if (text !== "") {
          return { text, time: typeof node.time === "number" ? node.time : undefined };
        }
      }
      return { text: "", time: undefined };
    }

    /* ══════════════════════════════════════════════════════════════
     * Turn 末尾的朗读按钮 + 自动朗读
     * ══════════════════════════════════════════════════════════════ */

    const ROW_STYLE = {
      display: "flex",
      alignItems: "center",
      gap: 8,
      margin: "2px 0 6px",
      minHeight: 22,
    };
    const BUTTON_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      padding: "2px 9px",
      fontSize: 12,
      lineHeight: "18px",
      color: "var(--dsw-alias-label-secondary)",
      background: "transparent",
      border: "1px solid var(--dsw-alias-border-l1)",
      borderRadius: 6,
      cursor: "pointer",
      fontFamily: "inherit",
    };
    const NOTE_STYLE = {
      fontSize: 11,
      color: "var(--dsw-alias-label-secondary)",
      opacity: 0.8,
    };

    /** 会话能不能出声 —— 问宿主（与 /tts 同一套门禁），按会话缓存。 */
    const accessCache = new Map();

    function accessOf(sessionId) {
      const key = String(sessionId ?? "");
      const cached = accessCache.get(key);
      if (cached !== undefined) return cached;
      const pending = fetch(`/sandrone/status?sessionId=${encodeURIComponent(key)}`, {
        cache: "no-store",
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => ({
          allowed: data?.allow !== false && data?.enabled !== false,
          preset: data?.preset ?? null,
        }))
        .catch(() => ({ allowed: true, preset: null }));
      accessCache.set(key, pending);
      return pending;
    }

    function SandroneTurnTail(props) {
      // 两路都取：槽自带的 standardProps `useChat`，以及注册时 inject 进来的 hook。
      const standard =
        typeof props.useChat === "function" ? props.useChat((s) => s) : undefined;
      const injected =
        typeof props.useSandroneChat === "function" ? props.useSandroneChat((s) => s) : undefined;
      const chat = injected ?? standard;
      const nodes = chat?.legacy?.nodes;
      const latest = useMemo(() => latestAssistant(nodes), [nodes]);
      const text = latest.text;
      const at = latest.time;
      // 设置经槽的 hooks 传进来（`hooks: { sandroneForm: form }` → `useSandroneForm`）。
      const formSnapshot =
        typeof props.useSandroneForm === "function"
          ? props.useSandroneForm((s) => s)
          : undefined;
      const form = formOf(formSnapshot);
      const values = valuesOf(form);
      const isSpeaking = useSpeaking();
      const seq = typeof props.seq === "number" ? props.seq : -1;
      const sessionId = props.sessionId;
      const [access, setAccess] = useState(null);

      useEffect(() => {
        let alive = true;
        void accessOf(sessionId).then((next) => {
          if (alive) setAccess(next);
        });
        return () => {
          alive = false;
        };
      }, [sessionId]);

      useEffect(() => {
        if (access === null || access.allowed !== true) return;
        if (seq < 0 || text === "") return;
        if (values.enabled !== true || values.autoSpeak !== true) return;
        if (!shouldAutoSpeak(sessionId, seq, at)) return;
        void speakText(sessionId, text, form);
        // 只在「新的 Turn 落位」时触发一次；text 变化不重播。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [access, sessionId, seq]);

      // 不是桑多涅的会话（或者语音关着）就整块不渲染，别在别人的回复下面留一颗按钮。
      if (access === null || access.allowed !== true) return null;
      if (values.enabled !== true || text === "") return null;

      const toggle = () => {
        if (isSpeaking) {
          stopSpeech();
          return;
        }
        void speakText(sessionId, text, form);
      };

      return h(
        "div",
        { style: ROW_STYLE },
        h(
          "button",
          {
            type: "button",
            style: BUTTON_STYLE,
            title: isSpeaking ? "停下来" : "用桑多涅的声音再念一遍（按这条回复的语气挑参考）",
            onClick: toggle,
          },
          isSpeaking ? "■" : "🔊",
          h("span", null, isSpeaking ? "停止" : "朗读"),
        ),
      );
    }

    /* ══════════════════════════════════════════════════════════════
     * 设置页
     * ══════════════════════════════════════════════════════════════ */

    /** 从浏览器模块表里取官方控件；拿不到就退回原生控件。 */
    function loadPrimitives() {
      try {
        return require("@deepseek-ai/dsh-client-ui-primitives") ?? null;
      } catch {
        return null;
      }
    }

    const SECTION_STYLE = { display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 };
    const GROUP_TITLE_STYLE = {
      fontSize: 13,
      fontWeight: 600,
      color: "var(--dsw-alias-label-primary)",
      margin: "6px 0 0",
    };
    const ROW_WRAP_STYLE = {
      display: "flex",
      alignItems: "flex-start",
      gap: 16,
      justifyContent: "space-between",
    };
    const LABEL_STYLE = { fontSize: 13, color: "var(--dsw-alias-label-primary)" };
    const HINT_STYLE = {
      fontSize: 12,
      color: "var(--dsw-alias-label-secondary)",
      lineHeight: "17px",
      marginTop: 2,
    };
    const INPUT_STYLE = {
      width: 280,
      padding: "4px 8px",
      fontSize: 12,
      color: "var(--dsw-alias-label-primary)",
      background: "var(--dsw-alias-bg-layer-2)",
      border: "1px solid var(--dsw-alias-border-l1)",
      borderRadius: 6,
      fontFamily: "inherit",
    };
    const NOTE_BLOCK_STYLE = {
      fontSize: 12,
      color: "var(--dsw-alias-label-secondary)",
      lineHeight: "18px",
    };

    function createSettings(ui) {
      const SwitchC = typeof ui?.Switch === "function" ? ui.Switch : null;
      const Segmented = typeof ui?.SegmentedControl === "function" ? ui.SegmentedControl : null;

      function Row(props) {
        return h(
          "div",
          { style: ROW_WRAP_STYLE },
          h(
            "div",
            { style: { flex: "1 1 auto", minWidth: 0 } },
            h("div", { style: LABEL_STYLE }, props.label),
            props.hint ? h("div", { style: HINT_STYLE }, props.hint) : null,
          ),
          h("div", { style: { flex: "0 0 auto", paddingTop: 1 } }, props.control),
        );
      }

      function SwitchControl(props) {
        if (SwitchC !== null) {
          return h(SwitchC, {
            checked: props.checked === true,
            label: props.label,
            disabled: props.disabled === true,
            onChange: props.onChange,
          });
        }
        return h("input", {
          type: "checkbox",
          checked: props.checked === true,
          disabled: props.disabled === true,
          "aria-label": props.label,
          onChange: (event) => props.onChange(event.target.checked),
        });
      }

      function Slider(props) {
        const value = typeof props.value === "number" ? props.value : props.fallback;
        return h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10 } },
          h("input", {
            type: "range",
            min: props.min,
            max: props.max,
            step: props.step,
            value,
            disabled: props.disabled === true,
            "aria-label": props.label,
            style: { width: 170 },
            onChange: (event) => props.onChange(Number(event.target.value)),
          }),
          h(
            "span",
            {
              style: {
                fontSize: 12,
                color: "var(--dsw-alias-label-secondary)",
                minWidth: 36,
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
              },
            },
            String(value),
          ),
        );
      }

      function TextInput(props) {
        const [draft, setDraft] = useState(props.value ?? "");
        useEffect(() => {
          setDraft(props.value ?? "");
        }, [props.value]);
        return h("input", {
          type: "text",
          value: draft,
          placeholder: props.placeholder,
          disabled: props.disabled === true,
          "aria-label": props.label,
          spellCheck: false,
          style: INPUT_STYLE,
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => {
            if (draft !== (props.value ?? "")) props.onCommit(draft);
          },
          onKeyDown: (event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          },
        });
      }

      function Choice(props) {
        if (Segmented !== null) {
          return h(Segmented, {
            id: `sandrone-${props.id}`,
            value: props.value,
            options: props.options,
            label: props.label,
            disabled: props.disabled === true,
            onChange: props.onChange,
          });
        }
        return h(
          "select",
          {
            value: props.value,
            disabled: props.disabled === true,
            "aria-label": props.label,
            style: INPUT_STYLE,
            onChange: (event) => props.onChange(event.target.value),
          },
          props.options.map((option) =>
            h("option", { key: option.value, value: option.value }, option.label),
          ),
        );
      }

      /** 链路状态 + 试听。状态直接读宿主，不猜。 */
      function LinkStatus(props) {
        const [status, setStatus] = useState(null);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");

        useEffect(() => {
          let alive = true;
          const load = async () => {
            try {
              const res = await fetch("/sandrone/status", { cache: "no-store" });
              const data = await res.json();
              if (alive) setStatus(data);
            } catch {
              if (alive) setStatus({ ok: false, lastError: "读不到 /sandrone/status" });
            }
          };
          void load();
          const timer = setInterval(load, 4000);
          return () => {
            alive = false;
            clearInterval(timer);
          };
        }, []);

        let line = "语音服务未启动（第一条回复时会自动拉起）";
        if (status?.ready === true) {
          line = `语音服务就绪｜${status.apiUrl}${status.pid ? `｜pid ${status.pid}` : ""}`;
        } else if (status?.lastError) {
          line = `语音服务异常：${status.lastError}`;
        } else if (status?.running === true) {
          line = "语音服务正在加载模型…";
        }

        const listen = async () => {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const ok = await speakText(
              "",
              "哼，试听也要看时机。算了，既然你点了，就让你听一句。",
              props.form,
            );
            if (!ok) setError("这一句没念出来，看看上面的服务状态。");
          } finally {
            setBusy(false);
          }
        };

        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { style: NOTE_BLOCK_STYLE }, line),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 10 } },
            h(
              "button",
              {
                type: "button",
                style: BUTTON_STYLE,
                disabled: busy,
                onClick: () => {
                  void listen();
                },
              },
              busy ? "合成中…" : "试听一句",
            ),
            error !== "" ? h("span", { style: NOTE_STYLE }, error) : null,
          ),
        );
      }

      return function SandroneSettings(props) {
        const snapshot =
          typeof props.useSandroneForm === "function" ? props.useSandroneForm((s) => s) : undefined;
        const values = useMemo(() => valuesOf({ getSnapshot: () => snapshot }), [snapshot]);
        const disabled = snapshot?.writable === false;
        const set = (field, value) => props.setSandroneField?.(field, value);

        const header = h(
          "div",
          null,
          h("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 6 } }, "桑多涅"),
          h(
            "div",
            { style: NOTE_BLOCK_STYLE },
            "她的设置只有这一处。人格在 agent preset 里，声音走本机的 GPT-SoVITS；这里改的值即时生效。",
          ),
        );

        if (snapshot?.status !== "ready") {
          const why =
            snapshot?.status === "unavailable"
              ? "宿主没有给这一页提供设置（当前的组合可能把设置存在别处）。"
              : "正在读取设置…";
          return h(
            "div",
            { style: SECTION_STYLE },
            header,
            h("div", { style: NOTE_BLOCK_STYLE }, why),
          );
        }

        const group = (title, rows) =>
          h(
            "section",
            { key: title },
            h("h3", { style: GROUP_TITLE_STYLE }, title),
            ...rows,
          );

        return h(
          "div",
          { style: SECTION_STYLE },
          header,
          group("说话", [
            h(Row, {
              key: "enabled",
              label: "启用桑多涅语音",
              hint: "关掉之后她不再出声，界面上的朗读按钮也会消失。",
              control: h(SwitchControl, {
                checked: values.enabled === true,
                label: "启用桑多涅语音",
                disabled,
                onChange: (next) => set("enabled", next),
              }),
            }),
            h(Row, {
              key: "autoSpeak",
              label: "回复结束后自动朗读",
              hint: "每轮回复说完就念；代码块、链接、Markdown 记号不会被念出来。",
              control: h(SwitchControl, {
                checked: values.autoSpeak === true,
                label: "回复结束后自动朗读",
                disabled,
                onChange: (next) => set("autoSpeak", next),
              }),
            }),
            h(Row, {
              key: "presetOnly",
              label: "只在「桑多涅」会话里说话",
              hint: "别的 agent 预设（比如黑塔）各自有自己的声音，不让两条声音叠在一起。",
              control: h(SwitchControl, {
                checked: values.presetOnly === true,
                label: "只在「桑多涅」会话里说话",
                disabled,
                onChange: (next) => set("presetOnly", next),
              }),
            }),
            h(Row, {
              key: "volume",
              label: "音量",
              control: h(Slider, {
                label: "音量",
                value: values.volume,
                fallback: DEFAULTS.volume,
                min: 0,
                max: 100,
                step: 1,
                disabled,
                onChange: (next) => set("volume", next),
              }),
            }),
            h(Row, {
              key: "speed",
              label: "语速",
              control: h(Slider, {
                label: "语速",
                value: values.speed,
                fallback: DEFAULTS.speed,
                min: 0.5,
                max: 2,
                step: 0.05,
                disabled,
                onChange: (next) => set("speed", next),
              }),
            }),
            h(Row, {
              key: "chunkChars",
              label: "分句长度（字）",
              hint: "越小越早出声，但停顿会变多。",
              control: h(Slider, {
                label: "分句长度",
                value: values.chunkChars,
                fallback: DEFAULTS.chunkChars,
                min: 30,
                max: 400,
                step: 10,
                disabled,
                onChange: (next) => set("chunkChars", next),
              }),
            }),
            h(Row, {
              key: "textLang",
              label: "朗读语言",
              hint: "桑多涅的正文是中文，固定 zh；选 ja/en 会让中文被读成日语/英语。旧配置里的 auto 已按 zh 处理。",
              control: h(Choice, {
                id: "text-lang",
                label: "朗读语言",
                value: values.textLang,
                options: [
                  { value: "zh", label: "zh（中文）" },
                  { value: "ja", label: "ja（日本語）" },
                  { value: "en", label: "en（English）" },
                ],
                disabled,
                onChange: (next) => set("textLang", next),
              }),
            }),
          ]),
          group("语气", [
            h(Row, {
              key: "toneAuto",
              label: "按回复语气自动挑参考",
              hint: "每轮回复按用词和标点，从 6 组「参考音频 + 逐字文本」里挑最贴近的一组。不额外调模型，不增加等待。",
              control: h(SwitchControl, {
                checked: values.toneAuto === true,
                label: "按回复语气自动挑参考",
                disabled,
                onChange: (next) => set("toneAuto", next),
              }),
            }),
            h(Row, {
              key: "fixedTone",
              label: "固定语气",
              hint: "关掉自动后：填了「手动参考音频」就用那一段，否则一律用这一组。",
              control: h(Choice, {
                id: "fixed-tone",
                label: "固定语气",
                value: TONE_NAME.has(values.fixedTone) ? values.fixedTone : FALLBACK_TONE,
                options: TONES.map((tone) => ({ value: tone.id, label: tone.label })),
                disabled: disabled || values.toneAuto === true,
                onChange: (next) => set("fixedTone", next),
              }),
            }),
            h(
              "div",
              { key: "tone-note", style: NOTE_BLOCK_STYLE },
              "GPT-SoVITS 的参考文本必须是参考音频的逐字转写，所以这里换的是一整组「音频 + 文本」；只改文本会让音色和韵律塌掉。",
            ),
          ]),
          group("GPT-SoVITS 合成链路", [
            h(Row, {
              key: "apiUrl",
              label: "语音服务地址",
              hint: "默认就是 api_v2.py 的 9880 端口。已经有服务在跑就直接复用，不会重复拉起。",
              control: h(TextInput, {
                label: "语音服务地址",
                value: values.apiUrl,
                placeholder: DEFAULTS.apiUrl,
                disabled,
                onCommit: (next) => set("apiUrl", next.trim()),
              }),
            }),
            h(Row, {
              key: "gptDir",
              label: "GPT-SoVITS 目录",
              hint: "只读它：模型、参考音频都从这里来，插件不会往这个目录写任何文件。",
              control: h(TextInput, {
                label: "GPT-SoVITS 目录",
                value: values.gptDir,
                placeholder: DEFAULTS.gptDir,
                disabled,
                onCommit: (next) => set("gptDir", next.trim()),
              }),
            }),
            h(Row, {
              key: "pythonPath",
              label: "Python 解释器",
              hint: "留空 = 目录自带的 runtime\\python.exe。",
              control: h(TextInput, {
                label: "Python 解释器",
                value: values.pythonPath,
                placeholder: "（留空用目录自带的 runtime\\python.exe）",
                disabled,
                onCommit: (next) => set("pythonPath", next.trim()),
              }),
            }),
            h(Row, {
              key: "autoStart",
              label: "自动启动语音服务",
              control: h(SwitchControl, {
                checked: values.autoStart === true,
                label: "自动启动语音服务",
                disabled,
                onChange: (next) => set("autoStart", next),
              }),
            }),
            h(Row, {
              key: "preload",
              label: "开机预热模型",
              hint: "启动 DSH 后几秒先把模型加载好，第一条回复不用等半分钟。",
              control: h(SwitchControl, {
                checked: values.preload === true,
                label: "开机预热模型",
                disabled,
                onChange: (next) => set("preload", next),
              }),
            }),
            h(Row, {
              key: "refAudio",
              label: "手动参考音频（可选）",
              hint: "自动语气开着时不用它；关掉自动语气后，填了就用这一段和下面的参考文本。留空 = 用「固定语气」那一组。",
              control: h(TextInput, {
                label: "手动参考音频",
                value: values.refAudio,
                placeholder: "（仅关闭自动语气后生效）",
                disabled,
                onCommit: (next) => set("refAudio", next.trim()),
              }),
            }),
            h(Row, {
              key: "promptText",
              label: "手动参考文本",
              hint: "上面那段手动参考音频里说的原话，逐字一致效果最好。",
              control: h(TextInput, {
                label: "手动参考文本",
                value: values.promptText,
                placeholder: DEFAULTS.promptText,
                disabled,
                onCommit: (next) => set("promptText", next),
              }),
            }),
            h(Row, {
              key: "promptLang",
              label: "参考文本语言",
              control: h(Choice, {
                id: "prompt-lang",
                label: "参考文本语言",
                value: values.promptLang,
                options: [
                  { value: "zh", label: "zh" },
                  { value: "ja", label: "ja" },
                  { value: "en", label: "en" },
                ],
                disabled,
                onChange: (next) => set("promptLang", next),
              }),
            }),
            h(LinkStatus, { key: "link", form: formOf(snapshot) }),
          ]),
        );
      };
    }

    /* ══════════════════════════════════════════════════════════════
     * 插件入口
     * ══════════════════════════════════════════════════════════════ */

    return {
      name: "sandrone",
      inject: ["slots", "uiConversation"],
      apply(ctx) {
        ctx.inject(["configForms", "slots"], (scoped) => {
          let form = null;
          try {
            form = scoped.configForms.get(NS);
          } catch (error) {
            console.log(`[dsh-sandrone] 拿不到设置表单：${String(error?.message ?? error)}`);
          }

          // ── 设置页 ────────────────────────────────────────────────
          let Section = null;
          try {
            Section = createSettings(loadPrimitives());
          } catch (error) {
            console.log(`[dsh-sandrone] 设置页未挂载：${String(error?.message ?? error)}`);
          }
          if (Section !== null && form !== null) {
            scoped.effect(
              () =>
                scoped.slots.inject("settings.section", () =>
                  scoped.slots.register(
                    {
                      name: "settings.section",
                      id: NS,
                      // account(-10) / general(0) / models(10) / plugins(15) / agent-presets(20)
                      order: 31,
                      label: () => "桑多涅",
                      inject: () => ({
                        hooks: { sandroneForm: form },
                        setSandroneField: (field, value) => {
                          void writeField(form, field, value);
                        },
                      }),
                    },
                    Section,
                  ),
                ),
              "dsh-sandrone: settings section",
            );
          }

          // ── 每轮结尾的朗读 ────────────────────────────────────────
          scoped.effect(
            () =>
              scoped.slots.inject("conversation.chat.turnTail", () =>
                scoped.slots.register(
                  {
                    name: "conversation.chat.turnTail",
                    id: "sandrone-read-aloud",
                    order: 12,
                    label: () => "桑多涅朗读",
                    inject: (sessionId) => {
                      // `inject` 的入参在不同槽上不一定是 sessionId；拿不到就退到
                      // standardProps 的 `useChat`，绝不让这里抛出去把槽弄坏。
                      const hooks = { sandroneForm: form };
                      try {
                        if (typeof sessionId === "string" && sessionId !== "") {
                          const binding = scoped.uiConversation?.binding?.(sessionId);
                          const target = binding?.target?.("chat");
                          if (typeof target === "function") hooks.sandroneChat = target;
                        }
                      } catch (error) {
                        console.log(
                          `[dsh-sandrone] 取不到 chat 钩子：${String(error?.message ?? error)}`,
                        );
                      }
                      return { hooks };
                    },
                  },
                  SandroneTurnTail,
                ),
              ),
            "dsh-sandrone: turn tail",
          );
        });

        ctx.effect(
          () => () => stopSpeech(),
          "dsh-sandrone: speech cleanup",
        );
      },
    };

    /** 写一个设置字段。表单自己的 mutate 会落到 profile 的 cordis.patch.yml。 */
    async function writeField(form, field, value) {
      try {
        await form.mutate([{ op: "set", path: [field], value }]);
      } catch (error) {
        console.log(`[dsh-sandrone] 设置写入失败（${field}）：${String(error?.message ?? error)}`);
      }
    }
  },
});
