import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  diffSegments,
  diffStats,
  segmentsToLines,
  formatStats,
  DIFF_TOKEN_CAP,
} from "../core/diff.mjs";

function apply(segs, kind) {
  return segs
    .filter((s) => s.type === kind || s.type === "same")
    .map((s) => s.text)
    .join("");
}

test("tokenize：中文逐字、英文成词、空白整体", () => {
  assert.deepEqual(tokenize("你好 world"), ["你", "好", " ", "world"]);
  assert.deepEqual(tokenize("a  b"), ["a", "  ", "b"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
});

test("diff：完全相同 → 全 same", () => {
  const segs = diffSegments("hello", "hello");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, "same");
  assert.equal(segs[0].text, "hello");
});

test("diff：自洽性——去掉 del 还原新文本，去掉 ins 还原旧文本", () => {
  const before = "请解释这段代码";
  const after = "请解释这段代码的功能和执行流程";
  const segs = diffSegments(before, after);
  assert.equal(apply(segs, "ins"), after);
  assert.equal(apply(segs, "del"), before);
});

test("diff：整段替换的自洽性同样成立", () => {
  const before = "abc def";
  const after = "完全不同的一段内容";
  const segs = diffSegments(before, after);
  assert.equal(apply(segs, "ins"), after);
  assert.equal(apply(segs, "del"), before);
});

test("diff：统计改动块数与增删字数", () => {
  // 用汉字：中文逐字切分，才能得到 1 增 1 删
  const segs = diffSegments("甲丙", "甲乙丙");
  const st = diffStats(segs);
  assert.equal(st.added, 1);
  assert.equal(st.removed, 0);
  assert.equal(st.delta, 1);
  assert.equal(st.changed, 1);

  const segs2 = diffSegments("甲乙丙", "甲丙");
  const st2 = diffStats(segs2);
  assert.equal(st2.added, 0);
  assert.equal(st2.removed, 1);
  assert.equal(st2.delta, -1);
});

test("diff：拉丁词按词切分，整词替换计为整词长度", () => {
  const segs = diffSegments("abc", "axc");
  const st = diffStats(segs);
  assert.equal(st.added, 3, "abc 是一个拉丁词 token");
  assert.equal(st.removed, 3);
  assert.equal(st.delta, 0);
});

test("diff：新增只增不减", () => {
  const st = diffStats(diffSegments("请解释", "请解释一下这段代码"));
  assert.equal(st.removed, 0);
  assert.ok(st.added > 0);
  assert.ok(st.delta > 0);
});

test("diff：超过 CAP 退化为整段替换", () => {
  const long = "字".repeat(DIFF_TOKEN_CAP + 10);
  const segs = diffSegments(long, "短");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].type, "del");
  assert.equal(segs[1].type, "ins");
});

test("segmentsToLines：按换行切行", () => {
  const segs = [
    { type: "same", text: "第一行\n第二" },
    { type: "ins", text: "行新增" },
  ];
  const lines = segmentsToLines(segs);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].map((s) => s.text).join(""), "第一行");
  assert.equal(lines[1].map((s) => s.text).join(""), "第二行新增");
});

test("formatStats：净变化带正负号", () => {
  assert.ok(formatStats({ changed: 2, added: 10, removed: 3, delta: 7 }).includes("净 +7 字"));
  assert.ok(formatStats({ changed: 1, added: 0, removed: 5, delta: -5 }).includes("净 -5 字"));
});

test("空字符串对空字符串不崩", () => {
  const segs = diffSegments("", "");
  assert.ok(Array.isArray(segs));
  assert.equal(diffStats(segs).delta, 0);
});
