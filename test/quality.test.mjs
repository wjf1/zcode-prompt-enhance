import test from "node:test";
import assert from "node:assert/strict";
import {
  checkUnchanged,
  checkTruncated,
  checkShrunk,
  assessQuality,
  QUALITY_CODES,
} from "../core/quality.mjs";

/* ---------------- 未改动判定 ---------------- */

test("未改动：完全相同的文本被判出", () => {
  const r = checkUnchanged("帮我写个排序函数", "帮我写个排序函数");
  assert.equal(r.code, "not-changed");
});

test("未改动：只差空白与标点差异也算未改动", () => {
  const r = checkUnchanged("帮我写个排序函数，要快", "帮我写个排序函数 要快。");
  assert.equal(r.code, "not-changed", "标点与空格差异不应掩盖'实质未变'");
});

test("未改动：全半角标点差异也算未改动", () => {
  const r = checkUnchanged("解释代码: 主要功能", "解释代码 ：主要功能");
  assert.equal(r.code, "not-changed");
});

test("未改动：真实改动不被误判", () => {
  assert.equal(checkUnchanged("帮我写个排序函数", "请实现一个稳定的归并排序函数，并说明其时间复杂度"), null);
});

test("未改动：空值交给 empty 分支，不在这里重复判", () => {
  assert.equal(checkUnchanged("", ""), null);
  assert.equal(checkUnchanged("原文", ""), null);
  assert.equal(checkUnchanged("", "结果"), null);
});

/* ---------------- 截断判定 ---------------- */

test("截断：悬空英文连接词", () => {
  assert.equal(checkTruncated("请实现该函数，并确保 and").code, "truncated");
  assert.equal(checkTruncated("write the parser and").code, "truncated");
});

test("截断：悬空中文连接词", () => {
  assert.equal(checkTruncated("请实现该函数以及").code, "truncated");
  assert.equal(checkTruncated("请列出全部字段和").code, "truncated");
});

test("截断：以冒号/逗号/开括号收尾", () => {
  assert.equal(checkTruncated("请按以下步骤执行：").code, "truncated");
  assert.equal(checkTruncated("需要说明的是，").code, "truncated");
  assert.equal(checkTruncated("请参考以下内容（").code, "truncated");
  assert.equal(checkTruncated("The output should be:").code, "truncated");
});

test("截断：末行列表项只剩标号没有正文", () => {
  assert.equal(checkTruncated("1. 读取输入\n2. 校验参数\n3.").code, "truncated");
  assert.equal(checkTruncated("- 第一步\n- 第二").code, "truncated");
});

test("截断：正常收尾不误报（中文短句不带句号是常态）", () => {
  assert.equal(checkTruncated("请解释这段代码的主要功能"), null);
  assert.equal(checkTruncated("Explain what this code does"), null);
  assert.equal(checkTruncated("1. 读取输入\n2. 校验参数\n3. 输出结果"), null);
});

test("截断：空值不判", () => {
  assert.equal(checkTruncated(""), null);
  assert.equal(checkTruncated(null), null);
});

/* ---------------- 缩水判定 ---------------- */

test("缩水：明显短于原文时判出", () => {
  const before = "请帮我写一个函数，这个函数需要接收一个数组作为输入，返回排序后的结果，要求稳定排序，并且要处理空数组和单元素数组的边界情况，性能上希望是 O(n log n)";
  const after = "写个排序函数";
  assert.equal(checkShrunk(before, after).code, "shrunk");
});

test("缩水：短原文不判定（短句本来就可以更短）", () => {
  assert.equal(checkShrunk("写个函数", "实现排序"), null);
});

test("缩水：正常增幅不判", () => {
  const before = "请帮我写一个排序函数，要求稳定排序，并处理空数组和单元素数组这两种边界情况，另外时间复杂度希望控制在 O(n log n) 以内";
  const after = before + "，最后附上三个覆盖上述边界情况的单元测试用例。";
  assert.equal(checkShrunk(before, after), null);
});

/* ---------------- 汇总 ---------------- */

test("汇总：阻断级问题排在最前，给出 blocking", () => {
  const r = assessQuality("帮我写个排序函数", "帮我写个排序函数");
  assert.equal(r.blocking.code, "not-changed");
});

test("汇总：缩水默认只算警告，不阻断", () => {
  const before = "请帮我写一个函数，这个函数需要接收一个数组作为输入，返回排序后的结果，要求稳定排序，并且要处理空数组和单元素数组的边界情况，性能上希望是 O(n log n)";
  const r = assessQuality(before, "写个排序函数");
  assert.equal(r.blocking, null, "缩水默认不阻断，避免误伤可用结果");
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, "shrunk");
});

test("汇总：strict 模式下缩水升级为阻断", () => {
  const before = "请帮我写一个函数，这个函数需要接收一个数组作为输入，返回排序后的结果，要求稳定排序，并且要处理空数组和单元素数组的边界情况，性能上希望是 O(n log n)";
  const r = assessQuality(before, "写个排序函数", { strict: true });
  assert.equal(r.blocking.code, "shrunk");
});

test("汇总：正常输出既不阻断也无警告", () => {
  const before = "帮我写个排序函数";
  const after = "请实现一个稳定的排序函数，接收数组并返回升序结果，同时处理空数组与单元素数组的边界情况";
  const r = assessQuality(before, after);
  assert.equal(r.blocking, null);
  assert.deepEqual(r.warnings, []);
});

test("质量码表覆盖所有判定码", () => {
  for (const c of ["not-changed", "truncated", "shrunk"]) {
    assert.ok(QUALITY_CODES[c], `缺少质量码文案: ${c}`);
  }
});
