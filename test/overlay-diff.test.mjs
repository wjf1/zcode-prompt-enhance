/**
 * 校验 overlay 内嵌的 diff 实现与 core/diff.mjs 行为一致。
 *
 * 0.3.3 起 overlay 的 diff 块由 tools/build-overlay.mjs 从 core/diff.mjs 构建期生成
 * （单一事实来源），本测试降级为产物校验：双向行为比对 + build-overlay --check，
 * 任何人手改生成块或改 core 忘跑构建，这里都会红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { diffSegments, diffStats, segmentsToLines, formatStats, tokenize as zpeTokenizeCore } from "../core/diff.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_SRC = fs.readFileSync(path.join(HERE, "..", "overlay-prompt-enhance.js"), "utf8");

/** 从 overlay 源码里抠出 diff 相关函数，在独立 vm 上下文里求值。 */
function loadOverlayDiff() {  const names = [
    "zpeTokenize",
    "zpeDiffSegments",
    "zpeDiffStats",
    "zpeSegmentsToLines",
    "zpeFormatStats",
    "computeDiff",
  ];
  const chunks = [];
  for (const name of names) {
    const re = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`, "m");
    const m = re.exec(OVERLAY_SRC);
    assert.ok(m, `overlay 里找不到函数 ${name}`);
    let i = OVERLAY_SRC.indexOf("{", m.index);
    let depth = 0;
    let end = -1;
    for (let k = i; k < OVERLAY_SRC.length; k += 1) {
      const ch = OVERLAY_SRC[k];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = k + 1;
          break;
        }
      }
    }
    assert.ok(end > 0, `函数 ${name} 的大括号不闭合`);
    chunks.push(OVERLAY_SRC.slice(m.index, end));
  }
  // 常量也要一起带进去（构建期生成的块用 const，历史手写副本是 var）
  const consts = OVERLAY_SRC.match(/(?:var|const|let) DIFF_TOKEN_CAP = \d+;/)?.[0];
  const reConst = OVERLAY_SRC.match(/(?:var|const|let) TOKEN_RE = .*?;/)?.[0];
  assert.ok(consts, "找不到 DIFF_TOKEN_CAP");
  assert.ok(reConst, "找不到 TOKEN_RE");

  const code = [consts, reConst, ...chunks, "module.exports={zpeTokenize,zpeDiffSegments,zpeDiffStats,zpeSegmentsToLines,zpeFormatStats,computeDiff};"].join("\n");
  const sandbox = { module: { exports: {} }, Uint16Array, Math, String, Array };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports;
}

const O = loadOverlayDiff();

/**
 * vm 里数组/对象来自另一个 realm，原型不同，deepStrictEqual 会因原型不等而失败。
 * 统一走 JSON 归一后再比较，语义仍然是逐字节相等。
 */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

const CASES = [
  ["", ""],
  ["abc", "abc"],
  ["请解释这段代码", "请解释这段代码的功能和执行流程"],
  ["帮我把这个函数改快一点", "扮演资深性能优化工程师。请先确认：\n- 函数源码：（待补充）"],
  ["write a function that reads a csv file", "Act as a software engineer.\n\nContext:\n- language: (TBD)"],
  ["a\nb\nc", "a\nx\nc"],
  ["多行\n文本\n内容", "多行\n新文本\n内容"],
  ["已删除的部分", ""],
  ["", "全新内容"],
];

test("tokenize 与 core 实现切分结果一致", () => {
  for (const [a, b] of CASES) {
    for (const s of [a, b]) {
      const mine = plain(O.zpeTokenize(s));
      const ref = plain(zpeTokenizeCore(s));
      assert.deepEqual(mine, ref, `tokenize 不一致: ${JSON.stringify(s)}`);
    }
  }
});

test("diff 段序列双方逐字节一致", () => {
  for (const [a, b] of CASES) {
    const mine = plain(O.zpeDiffSegments(a, b).map((s) => ({ type: s.type, text: s.text })));
    const ref = plain(diffSegments(a, b).map((s) => ({ type: s.type, text: s.text })));
    assert.deepEqual(mine, ref, `不一致的用例: ${JSON.stringify([a, b])}`);
  }
});

test("diff 统计双方一致", () => {
  for (const [a, b] of CASES) {
    const m = O.zpeDiffStats(O.zpeDiffSegments(a, b));
    const mine = { changed: m.changed, added: m.added, removed: m.removed, delta: m.delta };
    const ref = diffStats(diffSegments(a, b));
    assert.deepEqual(
      mine,
      { changed: ref.changed, added: ref.added, removed: ref.removed, delta: ref.delta },
      `统计不一致: ${JSON.stringify([a, b])}`
    );
  }
});

test("行切分双方一致", () => {
  for (const [a, b] of CASES) {
    const mine = plain(O.zpeSegmentsToLines(O.zpeDiffSegments(a, b)).map((ln) => ln.map((s) => ({ type: s.type, text: s.text }))));
    const ref = plain(segmentsToLines(diffSegments(a, b)).map((ln) => ln.map((s) => ({ type: s.type, text: s.text }))));
    assert.deepEqual(mine, ref, `行切分不一致: ${JSON.stringify([a, b])}`);
  }
});

test("统计文案双方一致", () => {
  for (const [a, b] of CASES) {
    const mine = O.zpeFormatStats(O.zpeDiffStats(O.zpeDiffSegments(a, b)));
    const ref = formatStats(diffStats(diffSegments(a, b)));
    assert.equal(mine, ref, `文案不一致: ${JSON.stringify([a, b])}`);
  }
});

test("computeDiff 输出结构完整", () => {
  const d = O.computeDiff("原文", "新的原文内容");
  assert.ok(Array.isArray(d.segs));
  assert.ok(d.stats && typeof d.stats.added === "number");
  assert.ok(Array.isArray(d.lines));
  assert.ok(typeof d.statsText === "string" && d.statsText.length > 0);
});

test("超长输入退化为整段替换（两边一致）", () => {
  const long = "字".repeat(900);
  const mine = plain(O.zpeDiffSegments(long, "短").map((s) => s.type));
  const ref = plain(diffSegments(long, "短").map((s) => s.type));
  assert.deepEqual(mine, ref);
});

test("产物校验：overlay diff 块与 core/diff.mjs 构建期同步（build-overlay --check）", () => {
  assert.ok(OVERLAY_SRC.includes("/* [ZPE:DIFF:BEGIN]"), "缺 BEGIN 标记");
  assert.ok(OVERLAY_SRC.includes("/* [ZPE:DIFF:END] */"), "缺 END 标记");
  const r = spawnSync(process.execPath, [path.join(HERE, "..", "tools", "build-overlay.mjs"), "--check"], {
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 0, `build-overlay --check 应通过（产物过期或脚本异常）：\n${r.stdout}${r.stderr}`);
});
