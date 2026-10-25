/**
 * GPT-SoVITS 本地合成链路的宿主侧管理。
 *
 * 形状很简单：桑多涅的模型在 `D:\GPT-SoVITS-v2pro-20250604`（用户自己训练好的
 * v2ProPlus 权重），官方自带 `api_v2.py` 就是一条「文本进、wav 出」的 HTTP 接口。
 * 这里做三件事：
 *
 *   1. **按需拉起** `api_v2.py`（用那个目录自带的 python），并等它把模型加载完；
 *   2. 把一次合成请求转发过去，把 wav 字节原样交回宿主路由；
 *   3. 插件卸载时把子进程收掉。
 *
 * ## 为什么必须小心「不要改那个目录」
 *
 * 用户明确要求不改 `D:\GPT-SoVITS-v2pro-20250604` 下的任何文件。所以：
 *   · 子进程用 `-B` 语义（`PYTHONDONTWRITEBYTECODE=1` + `PYTHONPYCACHEPREFIX` 指到
 *     系统临时目录），连 `__pycache__` 都不往那边写；
 *   · 传给它的是 `tts_infer.yaml` 的**临时副本**（`-c` 指到 %TEMP%）：GPT-SoVITS 启动时会
 *     `save_configs()` 回写配置文件，让它写临时副本就够了；
 *   · 不调用 `/set_gpt_weights`、`/set_sovits_weights` —— 那两个接口同样会回写配置。
 *     权重本来就写在 yaml 的 `custom` 段里（训练完就是这个模型），不需要切换；
 *   · 合成结果只在内存里走，不落盘到那个目录。
 *
 * ## 为什么读配置要 `.get()`
 *
 * DSH 的 volatile 字段是 `Volatile` 包装对象而不是裸值（`dsh-settings` 的
 * `plainConfig()` 里 `isVolatile(value) ? value.get() : value`）。直接当字符串用会拿到
 * `[object Object]`，症状是「配置看着对、链路全通、就是不出声」。这里统一过 live()。
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIELDS, FIELD_NAMES } from "./fields.js";
import { refSummary, toneRef } from "./refs.js";

/** 取一个字段的当前值（处理 volatile 包装）。 */
function live(raw) {
  if (raw !== null && typeof raw === "object" && typeof raw.get === "function") return raw.get();
  return raw;
}

/**
 * 把 loader 交下来的 config 归一化成一份普通对象。
 * @param {Record<string, unknown> | undefined} config - loader 行配置。
 * @returns {Record<string, unknown>} 每个字段都有值。
 */
export function settingsOf(config) {
  const out = {};
  for (const name of FIELD_NAMES) {
    const spec = FIELDS[name];
    const value = live(config?.[name]);
    if (spec.kind === "boolean") out[name] = typeof value === "boolean" ? value : spec.def;
    else if (spec.kind === "number") {
      out[name] = typeof value === "number" && Number.isFinite(value) ? value : spec.def;
    } else if (spec.kind === "enum") out[name] = spec.values.includes(value) ? value : spec.def;
    else out[name] = typeof value === "string" ? value : spec.def;
  }
  // 旧配置里的 `auto` 会让 GPT-SoVITS 按句猜语言，中文短句经常被猜成日语/英语。
  // 桑多涅的正文是中文，统一按 zh 合成就不会再掺日/英。
  if (out.textLang === "auto") out.textLang = "zh";
  return out;
}

/** 去掉 URL 末尾的斜杠。 */
function trimUrl(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 子进程与就绪状态 —— 一个进程一份，模块级；插件卸载时清掉。 */
const RUNTIME = {
  child: null,
  pid: null,
  ready: false,
  starting: null,
  lastError: "",
  log: [],
  startedAt: 0,
};

function pushLog(line) {
  const text = String(line ?? "").trim();
  if (text === "") return;
  for (const row of text.split(/\r?\n/)) {
    const cut = row.slice(0, 400);
    RUNTIME.log.push(cut);
  }
  while (RUNTIME.log.length > 60) RUNTIME.log.shift();
}

/**
 * 探一下接口是否已经在跑。
 *
 * `api_v2.py` 是 FastAPI，默认带 `/docs`。用它而不是 `/tts`：`/tts` 缺参数会返回 400，
 * 分不清「服务在」和「服务报错」。
 *
 * @param {string} apiUrl - 例：`http://127.0.0.1:9880`。
 * @param {number} timeoutMs - 单次探测超时。
 * @returns {Promise<boolean>} 是否已就绪。
 */
async function probe(apiUrl, timeoutMs = 1500) {
  try {
    const res = await fetch(`${trimUrl(apiUrl)}/docs`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 当前 python 解释器路径（空配置 = 目录自带的 runtime\python.exe）。 */
function pythonOf(settings) {
  const explicit = String(settings.pythonPath ?? "").trim();
  return explicit !== "" ? explicit : join(settings.gptDir, "runtime", "python.exe");
}

/**
 * 随插件走的「便携权重」目录。
 *
 * 换一台电脑时，模型（GPT 的 `.ckpt` 与 SoVITS 的 `.pth`）跟着插件躺在
 * `assets/weights/` 里，由 `install.ps1` 从仓库分卷还原 —— 不需要把它们塞进
 * GPT-SoVITS 目录，也就不用改那边的任何文件。
 *
 * 这里刻意用**固定文件名**：脚本还原时就叫这两个名字，插件这边不做目录扫描，
 * 免得把用户自己放进去的别的权重误认成桑多涅。
 */
const WEIGHTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "weights");
const PORTABLE_GPT = join(WEIGHTS_DIR, "sandrone-gpt.ckpt");
const PORTABLE_SOVITS = join(WEIGHTS_DIR, "sandrone-sovits.pth");

/**
 * 把 `custom:` 段里的权重路径换成便携权重的绝对路径。
 *
 * 只改 `custom` 这一段：`t2s_weights_path` / `vits_weights_path` 在 v1…v4 段里也各有一份，
 * 全局替换会把默认段落一起改坏（而且后出现的会覆盖前面的，等于没改）。
 *
 * 值用 JSON 字符串写入（YAML 双引号串接受它）：Windows 路径里的反斜杠在 YAML 双引号里
 * 必须转义，`JSON.stringify` 正好给出 `"D:\\a\\b"`。
 *
 * @param {string} yamlText - 原始 yaml 文本。
 * @param {string} gpt - 便携 GPT 权重绝对路径（空串 = 不改）。
 * @param {string} sovits - 便携 SoVITS 权重绝对路径（空串 = 不改）。
 * @returns {string} 打过补丁的 yaml 文本。
 */
export function patchPortableWeights(yamlText, gpt, sovits) {
  const lines = String(yamlText ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^custom:\s*$/.test(line));
  if (start < 0) return yamlText;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const block = lines.slice(start, end);
  const set = (key, value) => {
    const line = `  ${key}: ${JSON.stringify(value)}`;
    const at = block.findIndex((entry) => new RegExp(`^\\s*${key}:`).test(entry));
    if (at >= 0) block[at] = line;
    else block.splice(1, 0, line);
  };

  if (gpt !== "") set("t2s_weights_path", gpt);
  if (sovits !== "") set("vits_weights_path", sovits);
  // 便携权重是 v2ProPlus 训练出来的；整合包默认段可能是 v2Pro，版本不对会加载失败。
  set("version", "v2ProPlus");

  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

/**
 * 把 `tts_infer.yaml` **复制一份到临时目录**，返回那份副本的路径。
 *
 * 为什么不能直接用 `GPT_SoVITS/configs/tts_infer.yaml`：`TTS.init_*_weights()` 里有一句
 * `self.configs.save_configs()`，启动时会把配置文件**重新写一遍**（内容不变，但会动用户的
 * 文件）。用户明确要求那个目录一个字节都不能改，所以让 `api_v2.py` 读写临时副本 ——
 * 权重里的相对路径仍然按 cwd（GPT-SoVITS 目录）解析，效果一样。
 *
 * 每次拉起都重新复制，用户改了那边 yaml 里的权重，下一次启动就能跟上。
 */
function stagedConfig(settings) {
  const dir = join(tmpdir(), "dsh-sandrone");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "tts_infer.yaml");
  const source = join(String(settings.gptDir ?? ""), "GPT_SoVITS", "configs", "tts_infer.yaml");
  if (!existsSync(source)) {
    throw new Error(`找不到 TTS 配置：${source}（它应当由 GPT-SoVITS 自带）`);
  }
  copyFileSync(source, target);

  // 便携权重：仓库自带的模型跟着插件走，新电脑上不必往 GPT-SoVITS 目录里放任何东西。
  const gpt = existsSync(PORTABLE_GPT) ? PORTABLE_GPT : "";
  const sovits = existsSync(PORTABLE_SOVITS) ? PORTABLE_SOVITS : "";
  if (gpt !== "" || sovits !== "") {
    const patched = patchPortableWeights(readFileSync(target, "utf8"), gpt, sovits);
    writeFileSync(target, patched, "utf8");
    pushLog(`便携权重已接管：gpt=${gpt !== "" ? "有" : "无"} sovits=${sovits !== "" ? "有" : "无"}`);
  }

  return target;
}

/**
 * 拉起 `api_v2.py`。
 *
 * 参数保持官方默认：`-c GPT_SoVITS/configs/tts_infer.yaml` —— 那份 yaml 的 `custom`
 * 段就是桑多涅的训练权重。
 */
async function startServer(settings) {
  if (RUNTIME.child !== null) return;
  const dir = String(settings.gptDir ?? "").trim();
  if (dir === "") throw new Error("没有配置 GPT-SoVITS 目录");

  const python = pythonOf(settings);
  const script = join(dir, "api_v2.py");
  if (!existsSync(python)) throw new Error(`找不到 Python：${python}`);
  if (!existsSync(script)) throw new Error(`找不到 api_v2.py：${script}`);

  const url = new URL(trimUrl(settings.apiUrl));
  const host = url.hostname || "127.0.0.1";
  const port = url.port || (url.protocol === "https:" ? "443" : "80");

  const pycache = join(tmpdir(), "dsh-sandrone", "pycache");
  const configPath = stagedConfig(settings);
  const child = spawn(
    python,
    [script, "-a", host, "-p", String(port), "-c", configPath],
    {
      cwd: dir,
      env: {
        ...process.env,
        // 不往用户的 GPT-SoVITS 目录里写任何东西（连 __pycache__ 也不写）。
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPYCACHEPREFIX: pycache,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  RUNTIME.child = child;
  RUNTIME.pid = child.pid ?? null;
  RUNTIME.ready = false;
  RUNTIME.startedAt = Date.now();
  pushLog(
    `启动 api_v2.py：pid=${String(child.pid)} host=${host} port=${port} python=${python}`,
  );

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => pushLog(chunk));
  child.stderr?.on("data", (chunk) => pushLog(chunk));
  child.on("error", (error) => {
    RUNTIME.lastError = `启动 TTS 服务失败：${String(error?.message ?? error)}`;
    pushLog(RUNTIME.lastError);
  });
  child.on("exit", (code) => {
    RUNTIME.child = null;
    RUNTIME.ready = false;
    if (code !== 0 && code !== null) {
      RUNTIME.lastError = `TTS 服务退出了（code ${code}）`;
      pushLog(RUNTIME.lastError);
    } else {
      pushLog(`TTS 服务已退出（code ${String(code)}）`);
    }
  });
}

/**
 * 保证服务可用：先探端口，不在就拉起来，然后等模型加载完。
 * @param {Record<string, unknown>} settings - 归一化后的设置。
 * @returns {Promise<void>} 就绪时 resolve。
 */
export async function ensureServer(settings) {
  if (await probe(settings.apiUrl)) {
    RUNTIME.ready = true;
    return;
  }
  if (!settings.autoStart) {
    throw new Error("语音服务没有在运行，而「自动启动」是关着的。");
  }
  if (RUNTIME.starting !== null) return RUNTIME.starting;

  RUNTIME.starting = (async () => {
    if (RUNTIME.child === null) await startServer(settings);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (await probe(settings.apiUrl, 2000)) {
        RUNTIME.ready = true;
        RUNTIME.lastError = "";
        pushLog(`TTS 服务就绪（等待 ${Math.round((Date.now() - RUNTIME.startedAt) / 1000)}s）`);
        return;
      }
      if (RUNTIME.child === null) break;
      await sleep(700);
    }
    const tail = RUNTIME.log.slice(-6).join(" | ");
    throw new Error(
      `TTS 服务没能就绪。${RUNTIME.lastError !== "" ? RUNTIME.lastError : ""}${
        tail !== "" ? ` 日志：${tail}` : ""
      }`.trim(),
    );
  })().finally(() => {
    RUNTIME.starting = null;
  });

  return RUNTIME.starting;
}

/**
 * 合成一段文本。
 *
 * @param {Record<string, unknown>} settings - 归一化后的设置。
 * @param {string} text - 要念的文本。
 * @param {string} [tone] - 语气 id；留空/非法时退到 neutral。
 * @returns {Promise<Buffer>} wav 字节。
 */
export async function synthesize(settings, text, tone = "") {
  const body = String(text ?? "").trim();
  if (body === "") throw new Error("没有可合成的文本");

  await ensureServer(settings);

  const ref = toneRef(tone, settings);
  if (ref.audio === "") throw new Error("没有可用的参考音频");
  if (!existsSync(ref.audio)) throw new Error(`找不到参考音频：${ref.audio}`);

  const payload = {
    text: body,
    // 绝不再把 `auto` 交给 GPT-SoVITS：它的分句语种检测会把中文判成日语/英语。
    text_lang: settings.textLang === "auto" ? "zh" : settings.textLang,
    ref_audio_path: ref.audio,
    prompt_text: ref.text,
    prompt_lang: ref.lang,
    text_split_method: "cut5",
    batch_size: 1,
    speed_factor: settings.speed,
    media_type: "wav",
    streaming_mode: false,
  };

  const res = await fetch(`${trimUrl(settings.apiUrl)}/tts`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(240_000),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* 读不到正文时只报状态码 */
    }
    throw new Error(`GPT-SoVITS 拒绝了这次合成：HTTP ${res.status} ${detail.slice(0, 300)}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 128) throw new Error("GPT-SoVITS 返回了空音频");
  return bytes;
}

/** 后台预热（设置页「预加载」那一项）。失败只记日志，不抛。 */
export function warmUp(settings) {
  if (!settings.enabled || !settings.preload || !settings.autoStart) return;
  void ensureServer(settings).catch((error) => {
    RUNTIME.lastError = String(error?.message ?? error);
    pushLog(`预热失败：${RUNTIME.lastError}`);
  });
}

/** 一份给人看的状态。 */
export function statusOf(settings) {
  return {
    ready: RUNTIME.ready,
    running: RUNTIME.child !== null,
    pid: RUNTIME.pid,
    apiUrl: trimUrl(settings.apiUrl),
    gptDir: settings.gptDir,
    python: pythonOf(settings),
    refAudio: refSummary(settings),
    textLang: settings.textLang,
    toneAuto: settings.toneAuto,
    fixedTone: settings.fixedTone,
    autoStart: settings.autoStart,
    lastError: RUNTIME.lastError,
    log: RUNTIME.log.slice(-10),
  };
}

/** 关掉子进程（插件卸载 / 配置重载时）。 */
export function disposeServer() {
  const child = RUNTIME.child;
  RUNTIME.child = null;
  RUNTIME.ready = false;
  RUNTIME.pid = null;
  if (child === null) return;
  try {
    child.kill();
  } catch {
    /* 已经退出的子进程再 kill 会抛，忽略 */
  }
}
