/**
 * 把「语气」解析成一次合成真正要发给 GPT-SoVITS 的参考组。
 *
 * 两种模式：
 *   1. **语气库（默认）**：`refAudio` 留空时，按 `tone` 从 `assets/ref/` 取一组
 *      「wav + 逐字文本」。这是「每轮自动挑语气」的落点。
 *   2. **手动指定**：用户在设置里填了 `refAudio`，就用那一段和 `promptText`，
 *      忽略语气库 —— 留给「我想固定用某段参考」的场合。
 *
 * 这里只读插件自己的 `assets/`，不碰 `D:\GPT-SoVITS-v2pro-20250604`。
 *
 * @module dsh-sandrone/refs
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TONE, TONE_BY_ID } from "./tones.js";

/** 插件自带的参考音频目录。 */
const REF_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "ref");

/**
 * 解析一次合成的参考组。
 *
 * @param {string} tone - 语气 id；非法时退到 neutral。
 * @param {Record<string, unknown>} settings - 归一化后的设置。
 * @returns {{ tone: string, label: string, audio: string, text: string, lang: string, custom: boolean }}
 */
export function toneRef(tone, settings) {
  const custom = String(settings?.refAudio ?? "").trim();
  // 自动语气开着时，语气库说了算 —— 设置里残留的手动参考不能把「每轮自动挑」悄悄关掉。
  // 手动参考只在关掉自动语气后生效。
  if (settings?.toneAuto === false && custom !== "") {
    return {
      tone: "custom",
      label: "自定义参考",
      audio: custom,
      text: String(settings?.promptText ?? ""),
      lang: typeof settings?.promptLang === "string" ? settings.promptLang : "zh",
      custom: true,
    };
  }

  const entry = TONE_BY_ID.get(tone) ?? TONE_BY_ID.get(DEFAULT_TONE);
  return {
    tone: entry.id,
    label: entry.label,
    audio: join(REF_DIR, entry.audio),
    text: entry.text,
    lang: "zh",
    custom: false,
  };
}

/** 给设置页看的一句话：现在到底会用哪一组。 */
export function refSummary(settings) {
  if (settings?.toneAuto !== false) {
    return `语气参考库（${TONE_BY_ID.size} 组，按回复自动挑）`;
  }
  const custom = String(settings?.refAudio ?? "").trim();
  if (custom !== "") return "手动指定的参考音频";
  const fixed = TONE_BY_ID.get(settings?.fixedTone);
  return fixed === undefined ? "语气参考库（固定）" : `固定语气：${fixed.label}`;
}
