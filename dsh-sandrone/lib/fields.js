/**
 * 「桑多涅」的全部设置字段 —— 纯数据，无 IO、无 import。
 *
 * 为什么单独一个文件：宿主（index.js）要用它生成 Config，客户端设置页也要用同一套
 * 默认值。两边各写一份字面量的代价是「设置页能选、宿主判非法」这类漂移，所以默认值
 * 至少在宿主侧只有这一处真相。client.js 是浏览器 bundle，不能 import 这个文件，
 * 它内联了一份同名默认值 —— 改字段时**两处都要改**，字段名与默认值以本文件为准。
 *
 * 全部字段都是根级平铺，因为客户端写设置的口子只接受根级单字段
 * （`{ op: 'set', path: [field], value }`）。
 */

/** 设置命名空间 = profile 里那条 loader 条目的 id（cordis.patch.yml 的 `sandrone`）。 */
export const SETTINGS_NAMESPACE = "sandrone";

/** 人格预设的 id（preset/sandrone.patch.yml 里 config.id）。 */
export const PRESET_ID = "sandrone";

/**
 * 语气 id。顺序与 `tones.js` 的参考库一致；`fixedTone` 的枚举也用它。
 * 放在这个无 import 的文件里，是为了让宿主 Config 和客户端默认值都能引用同一份。
 */
export const TONE_IDS = Object.freeze(["neutral", "tease", "annoyed", "angry", "soft", "serious"]);

/**
 * 字段表。
 *
 * kind:
 *   - boolean：开关
 *   - enum：固定取值（values）
 *   - number：滑杆（min / max / step）
 *   - text：单行文本（路径、URL、参考文本）
 */
export const FIELDS = Object.freeze({
  /* ── 说话这件事的开关 ───────────────────────────────────────────── */
  enabled: {
    kind: "boolean",
    def: true,
  },
  autoSpeak: {
    kind: "boolean",
    def: true,
  },
  presetOnly: {
    kind: "boolean",
    def: true,
  },
  volume: {
    kind: "number",
    def: 100,
    min: 0,
    max: 100,
    step: 1,
  },
  speed: {
    kind: "number",
    def: 1,
    min: 0.5,
    max: 2,
    step: 0.05,
  },
  textLang: {
    kind: "enum",
    def: "zh",
    // `auto` 只留给旧配置通过 schema 校验；实际合成时一律按 zh（见 tts.js）。
    values: ["auto", "zh", "ja", "en"],
  },
  chunkChars: {
    kind: "number",
    def: 110,
    min: 30,
    max: 400,
    step: 10,
  },

  /* ── 语气 ──────────────────────────────────────────────────────── */
  toneAuto: {
    kind: "boolean",
    def: true,
  },
  fixedTone: {
    kind: "enum",
    def: "neutral",
    values: TONE_IDS,
  },

  /* ── GPT-SoVITS 合成链路 ────────────────────────────────────────── */
  apiUrl: {
    kind: "text",
    def: "http://127.0.0.1:9880",
  },
  gptDir: {
    kind: "text",
    def: "D:\\GPT-SoVITS-v2pro-20250604",
  },
  pythonPath: {
    kind: "text",
    def: "",
  },
  autoStart: {
    kind: "boolean",
    def: true,
  },
  preload: {
    kind: "boolean",
    def: true,
  },
  refAudio: {
    kind: "text",
    def: "",
  },
  promptText: {
    kind: "text",
    def: "死亡不过是一个平静的等号，而他现在去了公式的右边。",
  },
  promptLang: {
    kind: "enum",
    def: "zh",
    values: ["zh", "ja", "en"],
  },
});

export const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));

/**
 * 一个字段的出厂默认值。
 * @param {string} name - 字段名。
 * @returns {unknown} 默认值；未知字段返回 undefined。
 */
export function defaultOf(name) {
  return FIELDS[name]?.def;
}
