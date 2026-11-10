/**
 * 增强输出的质量判定。
 *
 * 背景：v0.4.0 之前只有 empty 一个兜底，导致三种真实缺陷被压成同一个模糊结果：
 *  1) 模型原样吐回草稿（用户点了 ✨ 却没有变化）；
 *  2) 输出被 max_tokens 之外的原因截断，停在半句话（上游没报 stop_reason）；
 *  3) 模型把「实质增强」做成了轻微同义改写，信息量反而下降。
 *
 * 这里把三类缺陷拆成独立判定，交给 enhancer 降级为可见错误码或警告。
 * 设计约束：
 *  - 全部是纯函数，不依赖网络与 DOM，可直接单测；
 *  - 判定必须偏保守：宁可放过一次可疑输出，也不要误伤正常结果
 *    （误报会让用户看到红色错误，而实际结果是可用的）。
 *  - 只判定"结构性缺陷"，不评判文采。
 */

/** 允许的判定结果码，与 ERROR_CODES 中的 quality 类目保持同步。 */
export const QUALITY_CODES = {
  "not-changed": "增强结果与原文实质相同",
  truncated: "输出疑似被截断",
  shrunk: "增强后信息量反而下降",
};

/**
 * 归一化用于"是否实质相同"的比较：抹掉空白差异与常见标点差异，
 * 避免只因空格/换行/标点全半角不同就判成"改过"。
 */
function comparableText(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\s]+/g, "")
    .replace(/[，,。.、；;：:！!？?（）()【】\[\]「」《》"'“”‘’—-]/g, "")
    .toLowerCase();
}

/**
 * 判定"是否实质未改动"。
 *
 * 阈值：归一化后完全相同 → not-changed；仅在只差 trailing 标点时也算。
 * 不做"相似度百分比"判定：编辑距离在中文短句上噪声极大，
 * 容易把一次正常的轻度增强判成未改动。
 *
 * @param {string} before 原始草稿
 * @param {string} after 增强结果
 * @returns {{code:string, detail?:string}|null} 无问题时返回 null
 */
export function checkUnchanged(before, after) {
  const a = comparableText(before);
  const b = comparableText(after);
  if (a === "" || b === "") return null; // 空值由 empty 分支处理，不在这里重复判
  if (a === b) return { code: "not-changed", detail: "结果与原文一致" };
  return null;
}

/**
 * 会出现在句末的固定搭配：这些词本身以「和 / 与 / 及」结尾，但它是完整的词，
 * 不是悬空连接词。没有这份白名单时，"计算总和" 会被误判成截断。
 */
const COMPOUND_TAIL = /(?:总和|求和|调和|平和|饱和|中和|附和|暖和|柔和|温和|随和|参与|给与|波及|普及|涉及|顾及)$/;

/** 多字中文连接词：出现在结尾基本等于句子没写完。 */
const DANGLING_ZH = /(?:以及|或者|或是|并且|而且|然后|其次|同时|包括|尤其|和|与|及|并|或)$/;
/** 英文连接词：必须有词边界，否则 "sand"、"brand" 会误命中。 */
const DANGLING_EN = /(?:^|[\s，,、；;(（])(?:and|or|but|with|for|then|plus)$/i;

/**
 * 判定"输出疑似被截断"。
 *
 * 只在明确的文本级证据上判定，三种证据任一成立即算：
 *  1) 以悬空连接词结尾（"and" / "以及" / "或者" 等）；
 *  2) 以未闭合的结构结尾：冒号、逗号、开括号；
 *  3) 最后一行是一个明显未写完的列表项（标号之后几乎没有正文）。
 *
 * 刻意不判"没有句末标点"：中文提示词常以短句收尾且不加句号，
 * 把它当截断会造成大量误报。
 *
 * @param {string} text
 * @returns {{code:string, detail:string}|null}
 */
export function checkTruncated(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return null;

  // 1) 悬空连接词（多字中文 / 带词边界的英文）
  if (!COMPOUND_TAIL.test(raw)) {
    const zh = DANGLING_ZH.exec(raw);
    if (zh) return { code: "truncated", detail: "以悬空连接词结尾：" + JSON.stringify(zh[0]) };
    const en = DANGLING_EN.exec(raw);
    if (en) return { code: "truncated", detail: "以悬空连接词结尾：" + JSON.stringify(en[0].trim()) };
  }

  // 2) 未闭合结构：冒号 / 逗号 / 开括号 / 破折号收尾
  const openChar = /[:：,，、\-—(（\[【「《]$/.exec(raw);
  if (openChar) return { code: "truncated", detail: "以未闭合符号结尾：" + JSON.stringify(openChar[0]) };

  /* 3) 末行列表项几乎没有正文。
   * 阈值取 3 个字：`3.`（空）、`- 第二`（2 字）判为未写完，
   * 而 `3. 输出结果`（4 字）是一个完整条目，不能误伤。 */
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const last = lines.length ? lines[lines.length - 1].trim() : "";
  const body = last.replace(/^(?:[-*+]|\d+[.)、])\s*/, "");
  if (/^(?:[-*+]|\d+[.)、])\s*/.test(last) && body.length <= 3) {
    return { code: "truncated", detail: "末行列表项未写完：" + JSON.stringify(last) };
  }

  return null;
}

/**
 * 判定"信息量明显缩水"。
 *
 * 判据保守：只有增强后长度不足原文 60% 时才算，
 * 且原文本身要有一定长度（少于 40 字不做判定 —— 短句本来就可以更短）。
 *
 * @param {string} before
 * @param {string} after
 * @returns {{code:string, detail:string}|null}
 */
export function checkShrunk(before, after) {
  const a = String(before ?? "").trim();
  const b = String(after ?? "").trim();
  if (a.length < 40) return null;
  if (b.length >= a.length * 0.6) return null;
  return { code: "shrunk", detail: "长度 " + a.length + " → " + b.length };
}

/**
 * 汇总所有质量判定。按"阻断级别"排序返回第一个问题：
 *  not-changed / truncated 视为阻断（结果是错的或无效的）；
 *  shrunk 视为警告（结果可能可用，只是信息量下降）。
 *
 * @param {string} before
 * @param {string} after
 * @param {{strict?:boolean}} [opts] strict=true 时 shrunk 也升级为阻断
 * @returns {{blocking: object|null, warnings: object[]}}
 */
export function assessQuality(before, after, opts = {}) {
  const warnings = [];
  const unchanged = checkUnchanged(before, after);
  const truncated = checkTruncated(after);
  const shrunk = checkShrunk(before, after);

  const blocking = unchanged || truncated || (opts.strict ? shrunk : null);
  if (shrunk && !blocking) warnings.push(shrunk);

  return { blocking, warnings };
}
