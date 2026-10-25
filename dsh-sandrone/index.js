/**
 * dsh-sandrone 的宿主（Node）半侧。
 *
 * 这个插件要做的事只有三件，全部落在宿主面：
 *
 *   1. **设置命名空间** —— profile 里那条 `id: sandrone` 的 loader 行就是她全部设置
 *      的唯一真相；字段全部 volatile，改了即时生效，不需要重挂插件。
 *   2. **语音网关** —— 浏览器侧只跟本站的 `/sandrone/*` 说话，由宿主去调用本地
 *      GPT-SoVITS 的 `api_v2.py`（训练好的桑多涅权重）。这样浏览器不用碰 CORS、
 *      也不用知道模型在哪。
 *   3. **会话门禁** —— 默认只给「桑多涅」预设的会话出声。黑塔那边也在给自己的会话
 *      配音，不能两条声音叠在一起。
 *
 * 人格本身不在这里：它在 `preset/sandrone.patch.yml` 里，作为一个 agent preset 装进
 * DSH（和黑塔插件同一个做法）。宿主这半侧不注册任何模型可见的东西，所以不会泄漏给
 * 别的预设。
 */
import z, { hasSchema } from "./lib/schema.js";
import { FIELD_NAMES, FIELDS, PRESET_ID, SETTINGS_NAMESPACE } from "./lib/fields.js";
import { DEFAULT_TONE, isToneId, pickTone, toneList } from "./lib/tones.js";
import {
  disposeServer,
  ensureServer,
  settingsOf,
  statusOf,
  synthesize,
  warmUp,
} from "./lib/tts.js";

/** Cordis 插件名，与 cordis.patch.yml 里的 loader 条目 id 一致。 */
export const name = "sandrone";

/**
 * 插件 Config —— 她全部设置的唯一真相。
 *
 * 每个字段都必须 `.volatile()`：`@deepseek-ai/dsh-settings` 只把 volatile 字段投影进
 * 表单，没有 volatile 字段的条目连 `describe()` 都会被跳过。换来的好处是这些字段
 * **改了就生效** —— loader 把新值提交进同一个引用，不重挂插件。
 */
export const Config = hasSchema
  ? z.object(
      Object.fromEntries(
        FIELD_NAMES.map((field) => {
          const spec = FIELDS[field];
          if (spec.kind === "boolean") return [field, z.boolean().default(spec.def).volatile()];
          if (spec.kind === "enum") {
            return [field, z.union([...spec.values]).default(spec.def).volatile()];
          }
          if (spec.kind === "number") {
            return [field, z.number().min(spec.min).max(spec.max).default(spec.def).volatile()];
          }
          return [field, z.string().default(spec.def).volatile()];
        }),
      ),
    )
  : undefined;

/** 路由前缀。客户端按这个前缀说话。 */
export const ROUTE_PREFIX = "/sandrone";

/**
 * 这个会话跑的是哪个预设。
 *
 * 读的是 `agentPresets.composedPreset(agent.ctx)`，也就是**运行时真正挂上的**那套组合，
 * 而不是会话创建时写进 header 的初始值 —— 后者在「新建会话后才在 Hero 里换成桑多涅」
 * 这条路径上是旧值，会把该出声的会话挡住。
 *
 * 读不到（老版本没有这个服务、会话不在线）就返回 undefined，调用方按「不拦」处理。
 *
 * @param {object} ctx - 宿主 cordis 上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {string | undefined} 预设 id。
 */
function presetOf(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  try {
    const agents = ctx.get("agents");
    const presets = ctx.get("agentPresets");
    const agent = agents?.get?.(sessionId);
    if (agent === undefined || agent === null) return undefined;
    if (typeof presets?.composedPreset !== "function") return undefined;
    return presets.composedPreset(agent.ctx);
  } catch {
    return undefined;
  }
}

/** 写一段 JSON。 */
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** 写一条纯文本错误。 */
function fail(res, status, message) {
  json(res, status, { ok: false, message });
}

/**
 * 挂 `/sandrone` 前缀路由。
 *
 *   GET/POST /sandrone/tts?text=…&sessionId=…&tone=…  →  audio/wav
 *   GET      /sandrone/tone?text=…                    →  JSON：这段回复该用哪组参考
 *   GET      /sandrone/tones                          →  JSON：语气参考库目录
 *   GET      /sandrone/status                         →  JSON 状态
 *
 * `tone` 由客户端按整条回复先算好再逐句带上；不传/传非法值时宿主按这一句现算。
 * `toneAuto=false` 时一律用 `fixedTone`，客户端传什么都不算数。
 *
 * @param {object} scoped - 带 webServer 的宿主上下文。
 * @param {() => Record<string, unknown>} current - 读当前设置。
 * @param {object} ctx - 根上下文（门禁要用 agents / agentPresets）。
 * @returns {() => void} disposer。
 */
function registerRoutes(scoped, current, ctx) {
  const webServer = scoped.get("webServer");
  if (webServer === undefined) return () => {};

  return webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      void (async () => {
        const settings = current();
        const url = new URL(req.url ?? "/", "http://localhost");
        const tail = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, "");

        if (tail === "status") {
          const sessionId = url.searchParams.get("sessionId") ?? "";
          const preset = presetOf(ctx, sessionId) ?? null;
          // `allow` 与 /tts 的门禁同一套判断：浏览器据此决定要不要显示朗读按钮。
          const allow = !settings.presetOnly || preset === null || preset === PRESET_ID;
          json(res, 200, {
            ok: true,
            ...statusOf(settings),
            presetOnly: settings.presetOnly,
            enabled: settings.enabled,
            preset,
            allow,
          });
          return;
        }

        if (tail === "tones") {
          json(res, 200, { ok: true, default: DEFAULT_TONE, tones: toneList() });
          return;
        }

        if (tail === "tone") {
          const sample = (url.searchParams.get("text") ?? "").trim();
          if (sample === "") {
            fail(res, 400, "text 是必填的");
            return;
          }
          if (sample.length > 4000) {
            fail(res, 413, "一次最多判 4000 字");
            return;
          }
          json(res, 200, { ok: true, ...pickTone(sample) });
          return;
        }

        if (tail !== "tts") {
          fail(res, 404, "没有这个端点");
          return;
        }

        if (!settings.enabled) {
          fail(res, 403, "桑多涅的语音被关掉了（设置页 → 桑多涅 → 启用语音）");
          return;
        }

        const text = (url.searchParams.get("text") ?? "").trim();
        if (text === "") {
          fail(res, 400, "text 是必填的");
          return;
        }
        if (text.length > 2000) {
          fail(res, 413, "一次最多念 2000 字");
          return;
        }

        if (settings.presetOnly) {
          const sessionId = url.searchParams.get("sessionId") ?? "";
          const preset = presetOf(ctx, sessionId);
          if (preset !== undefined && preset !== PRESET_ID) {
            fail(res, 409, `这个会话不是「桑多涅」预设（当前：${preset}），跳过朗读`);
            return;
          }
        }

        // 语气：固定模式 > 客户端带来的合法 tone > 按这一句现算。
        const requested = (url.searchParams.get("tone") ?? "").trim();
        const tone =
          settings.toneAuto === false
            ? isToneId(settings.fixedTone)
              ? settings.fixedTone
              : DEFAULT_TONE
            : isToneId(requested)
              ? requested
              : pickTone(text).id;

        try {
          const wav = await synthesize(settings, text, tone);
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": String(wav.length),
            "Cache-Control": "no-store",
            "X-Sandrone-Tone": tone,
          });
          res.end(wav);
        } catch (error) {
          const message = String(error?.message ?? error);
          console.log(`[dsh-sandrone] 合成失败：${message}`);
          fail(res, 502, message);
        }
      })().catch((error) => {
        try {
          fail(res, 500, String(error?.message ?? error));
        } catch {
          /* 响应已经发出去时再写会抛，忽略 */
        }
      });
    },
  });
}

/**
 * 声明设置命名空间的呈现方式：由本插件自带页面（客户端 `settings.section`）。
 *
 * 不这么声明的话，将来某个客户端按 schema 自动生成页时会多出一页。
 *
 * @param {object} ctx - 宿主 cordis 上下文。
 */
function installSettingsPresentation(ctx) {
  ctx.inject(["settings"], (scoped) => {
    scoped.effect(
      () => scoped.settings.configure({ auto: false }, ctx.fiber),
      "dsh-sandrone: settings presentation",
    );
    console.log(`[dsh-sandrone] 设置命名空间已就绪：${SETTINGS_NAMESPACE}`);
  });
}

/**
 * @param {object} ctx - 宿主 cordis 上下文。
 * @param {Record<string, unknown>} config - loader 行配置（volatile 包装）。
 */
export function apply(ctx, config) {
  console.log("[dsh-sandrone] 宿主半侧已挂载");
  if (!hasSchema) {
    console.log("[dsh-sandrone] 警告：拿不到 schemastery，这个插件没有 Config（设置页会降级）");
  }

  /** 每次读都现算，所以设置页改完下一句就生效。`refAudio` 留空 = 用语气参考库。 */
  const current = () => settingsOf(config);

  installSettingsPresentation(ctx);

  ctx.inject(["webServer"], (scoped) => {
    scoped.effect(
      () => registerRoutes(scoped, current, ctx),
      "dsh-sandrone: /sandrone routes",
    );
    console.log(`[dsh-sandrone] 语音网关已挂：${ROUTE_PREFIX}`);
  });

  // 预热：开机后过几秒把模型加载起来，免得第一条回复要等半分钟。
  // 失败不抛（模型没装、显卡被占），下一次合成还会再试。
  ctx.effect(
    () => {
      const timer = setTimeout(() => warmUp(current()), 5_000);
      return () => {
        clearTimeout(timer);
        disposeServer();
      };
    },
    "dsh-sandrone: warmup",
  );
}
