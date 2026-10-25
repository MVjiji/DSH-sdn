/**
 * 「语气 → 参考音频」参考库，以及从回复文本里挑语气的判据。
 *
 * ## 为什么是「一整组」而不是单独换参考文本
 *
 * GPT-SoVITS 的 `prompt_text` 是**参考音频的逐字转写**。只换文本、不换音频，
 * 等于让模型拿一段对不上的话去对齐音素，音色和韵律都会塌。所以要换语气，
 * 必须连音频一起换 —— 这里每个 tone 都是一组「wav + 它自己的逐字文本」。
 *
 * ## 音频从哪来
 *
 * 全部来自用户自己训练集 `logs/桑多涅v1.0.1/5-wav32k` 里的切片（32 kHz 单声道），
 * 复制进插件 `assets/ref/`，只读，不改 `D:\GPT-SoVITS-v2pro-20250604`。
 *
 * ## 谁挑
 *
 * `pickTone()` 是一个纯函数：按回复里的口头禅、情绪词和标点打分，选最贴近的一组。
 * 不额外调模型，所以不增加等待时间。没命中就回 `neutral`（那段最稳的参考音频）。
 *
 * 判据刻意写得保守：宁可回 neutral，也不要在普通技术回复里硬塞一段炸毛的语调。
 *
 * @module dsh-sandrone/tones
 */
import { TONE_IDS } from "./fields.js";

/**
 * 参考库。`audio` 是相对 `assets/ref/` 的文件名，`text` 是那段音频的逐字转写。
 *
 * `TONE_IDS` 的顺序以 `fields.js` 为准；这里必须一一对上，漏一个会在
 * `TONE_BY_ID` 里拿不到，`refs.js` 会退到 neutral。
 */
export const TONES = Object.freeze([
  {
    id: "neutral",
    label: "平静",
    desc: "平常说话：冷静、平稳，像 PV 里那样压低声音、慢慢说。",
    audio: "neutral.wav",
    text: "这没什么难度,列举他的事迹,再选上一句能代表他的话很遗憾,但这就是结局.",
  },
  {
    id: "tease",
    label: "揶揄",
    desc: "看好戏、嘴上半夸半损，带一点「就这？」的得意。",
    audio: "tease.wav",
    text: "这便是他常说的话,听起来有些悲观,哼,对不了解他的人来说是有点儿吧.",
  },
  {
    id: "annoyed",
    label: "嫌烦",
    desc: "不耐烦，但不喊：只是把「又来了」写在语气里。",
    audio: "annoyed.wav",
    text: "又是一个让人不省心的同事,明明能和兄弟姐妹开开心心过日子,干嘛偏要来当什么执行官?",
  },
  {
    id: "angry",
    label: "冷淡",
    desc: "收起情绪，冷冷地怼回去；不是炸毛，是把你晾在那儿。",
    audio: "angry.wav",
    text: "我讨厌做自我介绍,该认识我的自然会认识,不需要认识的,我何必去费这力气不过.",
  },
  {
    id: "soft",
    label: "别扭",
    desc: "少见地放轻：茶会、被夸到别扭、担心人。",
    audio: "soft.wav",
    text: "啊,差不多该约一次茶会了吧,也不知道其他人有没有空.",
  },
  {
    id: "serious",
    label: "认真",
    desc: "收起刺，认真或低落：阿兰、死亡、告别、活着。",
    audio: "serious.wav",
    text: "阿兰死后,我为他立了一块墓碑,他生前说希望我来为他撰写墓志铭,于是我写了.",
  },
]);

/** 找不到 tone 时的兜底。 */
export const DEFAULT_TONE = "neutral";

/** 按 id 查一组参考。 */
export const TONE_BY_ID = new Map(TONES.map((tone) => [tone.id, tone]));

/** 一个 id 是不是合法的语气。 */
export function isToneId(value) {
  return typeof value === "string" && TONE_BY_ID.has(value);
}

/** 给设置页/状态接口的轻量目录（不带判据和音频路径）。 */
export function toneList() {
  return TONES.map(({ id, label, desc }) => ({ id, label, desc }));
}

/**
 * 判据表。词是「出现即计分」，较长/更具体的词权重更高。
 *
 * 不列单个「别」「不」这类高频虚词 —— 它们几乎每句都有，只会把语气判歪。
 */
const RULES = Object.freeze({
  angry: [
    ["凭什么", 2.0],
    ["精神病", 2.0],
    ["闭嘴", 1.6],
    ["滚开", 1.6],
    ["去死", 1.6],
    ["混蛋", 1.4],
    ["废物", 1.4],
    ["蠢货", 1.4],
    ["该死", 1.4],
    ["烦死", 1.4],
    ["气死", 1.4],
    ["白痴", 1.2],
    ["笨蛋", 1.2],
    ["恼火", 1.2],
    ["火大", 1.2],
    ["可恶", 1.2],
    ["滚", 1.0],
    ["蠢", 1.0],
    ["过分", 1.0],
    ["讨厌", 1.0],
    ["恨", 1.0],
  ],
  annoyed: [
    ["真服了", 1.2],
    ["受不了", 1.2],
    ["懒得", 1.0],
    ["够了", 1.0],
    ["没空", 1.0],
    ["别烦", 1.0],
    ["别拿", 1.0],
    ["真是的", 1.0],
    ["哈？", 0.8],
    ["哈?", 0.8],
    ["麻烦", 0.8],
    ["又来", 0.8],
    ["别问", 0.8],
    ["行吧", 0.7],
    ["算了", 0.7],
    ["切", 0.6],
    ["啧", 0.6],
    ["随便", 0.6],
    ["哼", 0.5],
    ["唉", 0.5],
    ["喂", 0.4],
  ],
  tease: [
    ["就这", 1.4],
    ["也不过", 1.2],
    ["有点意思", 1.2],
    ["识相", 1.2],
    ["算你", 1.2],
    ["小看", 1.2],
    ["了不起", 1.2],
    ["不然呢", 1.2],
    ["呵呵", 1.2],
    ["啊哈", 1.2],
    ["哈哈", 1.2],
    ["厉害", 1.0],
    ["佩服", 1.0],
    ["夸奖", 1.0],
    ["不是吗", 1.0],
    ["你说呢", 1.0],
    ["有趣", 1.0],
    ["瞧瞧", 1.0],
    ["哦？", 1.0],
    ["哦?", 1.0],
    ["是吗", 1.0],
  ],
  soft: [
    ["少来这套", 1.4],
    ["别盯着", 1.2],
    ["茶会", 1.2],
    ["谢谢", 1.0],
    ["抱歉", 1.0],
    ["对不起", 1.0],
    ["别担心", 1.0],
    ["毛茸茸", 1.0],
    ["辛苦", 0.8],
    ["慢慢", 0.8],
    ["休息", 0.8],
    ["好吧", 0.8],
    ["点心", 0.9],
    ["陪", 0.6],
    ["抱", 0.6],
    ["嗯", 0.6],
    ["茶", 0.9],
  ],
  serious: [
    ["墓碑", 1.2],
    ["阿兰", 1.0],
    ["死亡", 1.0],
    ["失去", 0.8],
    ["告别", 0.8],
    ["活着", 0.8],
    ["意义", 0.8],
    ["命运", 0.8],
    ["认真", 0.8],
    ["记住", 0.8],
    ["其实", 0.6],
    ["明白", 0.6],
    ["最后", 0.6],
    ["世界", 0.5],
  ],
});

/** 同分时的优先级：越有情绪的越优先，neutral 最后。 */
const PRIORITY = Object.freeze(["angry", "annoyed", "tease", "soft", "serious", "neutral"]);

/** 最少要拿到多少分才不判成 neutral。 */
const THRESHOLD = 0.8;

/** 取一段文本里某个词的出现次数（最多算 3 次，避免复读刷分）。 */
function countOf(text, word) {
  let count = 0;
  let from = 0;
  while (count < 3) {
    const at = text.indexOf(word, from);
    if (at < 0) break;
    count += 1;
    from = at + word.length;
  }
  return count;
}

/** 四舍五入到两位，给日志和调试用。 */
function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 从回复文本里挑一组参考语气。
 *
 * @param {string} raw - 回复正文（已去 Markdown/代码块也行，不去也不影响）。
 * @returns {{ id: string, label: string, score: number }} 选中的语气。
 */
export function pickTone(raw) {
  const text = String(raw ?? "");
  const scores = Object.create(null);
  for (const id of TONE_IDS) scores[id] = 0;

  const head = text.slice(0, 24);
  for (const [id, rules] of Object.entries(RULES)) {
    if (!(id in scores)) continue;
    for (const [word, weight] of rules) {
      const count = countOf(text, word);
      if (count === 0) continue;
      // 开场就出现的词更代表这一整段的语气。
      scores[id] += weight * count * (head.includes(word) ? 1.15 : 1);
    }
  }

  const exclaims = (text.match(/[！!]/g) ?? []).length;
  const questions = (text.match(/[？?]/g) ?? []).length;
  const ellipses = (text.match(/……|\.\.\./g) ?? []).length;
  scores.angry += Math.min(exclaims, 3) * 0.5;
  scores.tease += Math.min(questions, 3) * 0.25;
  scores.soft += Math.min(ellipses, 2) * 0.3;

  const ranked = TONE_IDS.map((id) => ({ id, score: scores[id] ?? 0 })).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id);
  });

  const top = ranked[0];
  if (top === undefined || top.score < THRESHOLD) {
    return { id: DEFAULT_TONE, label: TONE_BY_ID.get(DEFAULT_TONE).label, score: 0 };
  }
  return {
    id: top.id,
    label: TONE_BY_ID.get(top.id).label,
    score: round(top.score),
  };
}
