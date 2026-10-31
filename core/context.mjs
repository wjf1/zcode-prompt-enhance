/**
 * 会话上下文装配（P2 上下文感知）。
 *
 * 职责：把渲染端（未来也可来自宿主钩子）上报的原始上下文整理成一段
 * 受预算约束的 <conversation_context> 内容，交给 enhanceDraft → frameUserPrompt。
 * 预算方向「从新到旧」：越靠近草稿的轮次越优先保留（DESIGN.md §5.2 采用的 npm 版策略）。
 *
 * 开关与安全语义：
 *  - 总开关是 config.json 的 context_enabled（默认 false）。关闭时主进程根本不装配，
 *    增强链路与无上下文基线逐字节一致（test/prompt.test.mjs 守住 system prompt 与
 *    frameUserPrompt 的两侧行为）。
 *  - 输出内容随后仍会经过 frameUserPrompt 的 CTX_TAG_RE 转义：上下文里出现
 *    </conversation_context> 字面量也无法提前闭合定界帧，本模块不做重复转义。
 *  - 本模块只产出纯文本，绝不触碰 provider 凭据，也不解释上下文内容。
 */

export const DEFAULT_MAX_MESSAGES = 8;
export const DEFAULT_MAX_CHARS = 4000;

/** 角色白名单与别名归一；未知角色一律丢弃（宁可少一段上下文，不可注入意外角色）。 */
const ROLE_ALIASES = new Map([
  ["user", "user"],
  ["human", "user"],
  ["assistant", "assistant"],
  ["ai", "assistant"],
  ["bot", "assistant"],
  ["model", "assistant"],
]);

function codePoints(s) {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** 保留字符串末尾 n 个 code point（被截断时以 … 开头标记）。 */
function keepTail(s, n) {
  if (n <= 0) return "";
  const arr = Array.from(s);
  if (arr.length <= n) return s;
  return "…" + arr.slice(arr.length - n).join("");
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 把原始输入规范化为 [{role, text}]（时间正序）。
 *
 * 接受两种形状：
 *  - 字符串：视为一段"预装配"的上下文，整体当作一条 user 轮次（受同一预算约束）；
 *  - 数组：元素为 {role, text|content} 或纯字符串（字符串 = user 轮次）。
 * 其余形状（数字、普通对象、null）一律得到空数组 —— 缺位安静降级为无上下文。
 */
export function normalizeTurns(raw) {
  const turns = [];
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text !== "") turns.push({ role: "user", text });
    return turns;
  }
  if (!Array.isArray(raw)) return turns;
  for (const item of raw) {
    let role = "user";
    let text = "";
    if (typeof item === "string") {
      text = item;
    } else if (item && typeof item === "object") {
      const r = typeof item.role === "string" ? item.role.trim().toLowerCase() : "";
      const mapped = ROLE_ALIASES.get(r);
      if (!mapped) continue; // 未知角色丢弃
      role = mapped;
      if (typeof item.text === "string") text = item.text;
      else if (typeof item.content === "string") text = item.content;
      else continue;
    } else {
      continue;
    }
    const t = text.trim();
    if (t === "") continue; // 空轮次丢弃
    turns.push({ role, text: t });
  }
  return turns;
}

/**
 * 装配上下文文本。
 *
 * @param {string|Array<{role?:string,text?:string,content?:string}>|*} raw 原始上下文
 * @param {{maxMessages?:number, maxChars?:number}} [opts] 预算；缺省用 DEFAULT_*
 * @returns {string} 可直接作为 <conversation_context> 内容的文本；无可用品时为 ""
 *
 * 规则：
 *  1. 只保留最近 maxMessages 条（先按条数截断）；
 *  2. 从最新一条往旧累积，字符预算（code point 计）耗尽即停，更旧的整条放弃；
 *  3. 最新一条单独超预算时保留其尾部（离草稿最近的部分），以 … 标记截断；
 *  4. 输出按时间正序（旧行在前），每行格式 `[user] 文本` / `[assistant] 文本`。
 */
export function assembleContext(raw, opts = {}) {
  const maxMessages = clampInt(opts.maxMessages, 1, 50, DEFAULT_MAX_MESSAGES);
  const maxChars = clampInt(opts.maxChars, 1, 100000, DEFAULT_MAX_CHARS);

  const recent = normalizeTurns(raw).slice(-maxMessages);

  const kept = [];
  let budget = maxChars;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const line =
      (recent[i].role === "assistant" ? "[assistant] " : "[user] ") + recent[i].text;
    // +1 为行间换行分隔符（首行不计）
    const cost = codePoints(line) + (kept.length > 0 ? 1 : 0);
    if (cost > budget) {
      if (kept.length === 0) {
        // 最新一条独超预算：保尾而不是整条放弃 —— 离草稿最近的信息价值最高
        kept.push(keepTail(line, maxChars));
      }
      break;
    }
    kept.push(line);
    budget -= cost;
  }
  return kept.reverse().join("\n");
}
