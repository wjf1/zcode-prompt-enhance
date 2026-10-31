/**
 * token 级 LCS diff（零依赖）。
 *
 * 切分粒度：连续空白整体 / 单个汉字 / 拉丁词与数字 / 其它单字符。
 * 中文逐字 → 视觉上接近字符级高亮；英文词级 → 不会把单词拆碎。
 *
 * 表规模上限 DIFF_TOKEN_CAP：超过就退化成整段替换，避免卡住输入框。
 */

export const DIFF_TOKEN_CAP = 800;

const TOKEN_RE = /\s+|[\u3400-\u9fff]|[A-Za-z0-9_]+|[^\s]/g;

export function tokenize(text) {
  return String(text ?? "").match(TOKEN_RE) || [];
}

/**
 * 计算 diff 段序列。
 * @returns {{type:'same'|'del'|'ins', text:string}[]}
 */
export function diffSegments(before, after) {
  const a = tokenize(before);
  const b = tokenize(after);

  if (a.length > DIFF_TOKEN_CAP || b.length > DIFF_TOKEN_CAP) {
    const segs = [];
    if (before) segs.push({ type: "del", text: String(before) });
    if (after) segs.push({ type: "ins", text: String(after) });
    return segs;
  }

  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const table = new Uint16Array((n + 1) * w);

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + j + 1] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }

  const segs = [];
  const push = (type, text) => {
    const last = segs[segs.length - 1];
    if (last && last.type === type) last.text += text;
    else segs.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      push("del", a[i]);
      i += 1;
    } else {
      push("ins", b[j]);
      j += 1;
    }
  }
  while (i < n) {
    push("del", a[i]);
    i += 1;
  }
  while (j < m) {
    push("ins", b[j]);
    j += 1;
  }
  return segs;
}

/**
 * 统计：改动块数、新增字符数、删除字符数、净变化。
 * "处"按连续同类段的段数计。
 */
export function diffStats(segs) {
  let changedBlocks = 0;
  let added = 0;
  let removed = 0;
  let prevType = "same";
  for (const s of segs) {
    const len = [...s.text].length;
    if (s.type === "ins") added += len;
    else if (s.type === "del") removed += len;
    if (s.type !== "same" && prevType !== s.type) changedBlocks += 1;
    prevType = s.type;
  }
  return { changed: changedBlocks, added, removed, delta: added - removed };
}

/** 把 diff 段按换行重新切行，避免长提示词渲染成一整块。 */
export function segmentsToLines(segs) {
  const lines = [[]];
  for (const s of segs) {
    const parts = s.text.split("\n");
    parts.forEach((part, k) => {
      if (k > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1].push({ type: s.type, text: part });
    });
  }
  return lines;
}

/** 统计行文案。 */
export function formatStats(stats) {
  const sign = stats.delta >= 0 ? "+" : "-";
  return `${stats.changed} 处改动 · ${stats.added} 字新增 / ${stats.removed} 字替换 · 净 ${sign}${Math.abs(stats.delta)} 字`;
}

/** 一次算全：段序列 + 统计 + 行切分 + 文案。overlay 的 diff 块由本文件生成（tools/build-overlay.mjs）。 */
export function computeDiff(before, after) {
  const segs = diffSegments(before, after);
  const stats = diffStats(segs);
  return { segs, stats, lines: segmentsToLines(segs), statsText: formatStats(stats) };
}
