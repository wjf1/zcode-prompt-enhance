/**
 * core/context.mjs 单元测试（P2 上下文感知）。
 *
 * 另含两条静态断言：主进程接线必须受 context_enabled 门控、必须走 assembleContext
 * 装配（不许透传原始 payload.context —— 无预算的透传是回归）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_MESSAGES,
  assembleContext,
  normalizeTurns,
} from "../core/context.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("默认预算与 inject-main.cjs 的 DEFAULTS 一致（8 条 / 4000 字）", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "inject-main.cjs"), "utf8");
  assert.ok(src.includes("context_max_messages: 8"), "inject-main 应有 context_max_messages: 8");
  assert.ok(src.includes("context_max_chars: 4000"), "inject-main 应有 context_max_chars: 4000");
  assert.equal(DEFAULT_MAX_MESSAGES, 8);
  assert.equal(DEFAULT_MAX_CHARS, 4000);
});

test("接线静态断言：context_enabled 门控 + assembleContext 装配", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "inject-main.cjs"), "utf8");
  assert.ok(src.includes("core/context.mjs"), "loadCore 应引入 core/context.mjs");
  assert.ok(/c\.context_enabled\s*\?/.test(src), "装配必须受 context_enabled 门控");
  assert.ok(src.includes("assembleContext("), "必须经 assembleContext 装配，不得透传原始 payload.context");
});

test("空输入族：undefined / null / 空串 / 空数组 / 非字符串非数组 → 空串", () => {
  for (const v of [undefined, null, "", "   ", [], 123, { role: "user", text: "x" }]) {
    assert.equal(assembleContext(v), "", `输入 ${JSON.stringify(v)} 应得到空串`);
  }
});

test("normalizeTurns：字符串 → 单条 user 轮次", () => {
  assert.deepEqual(normalizeTurns("  你好\n世界  "), [{ role: "user", text: "你好\n世界" }]);
});

test("normalizeTurns：角色别名归一 + 未知角色与空文本丢弃", () => {
  const turns = normalizeTurns([
    { role: "human", text: "第一条" },
    { role: "AI", text: "回复一" },
    { role: "system", text: "不应出现" },
    { role: "user", text: "   " },
    { role: "user", text: "" },
    { role: "user" },
    "纯字符串轮次",
    null,
    42,
    { role: "bot", content: "content 字段也算" },
  ]);
  assert.deepEqual(turns, [
    { role: "user", text: "第一条" },
    { role: "assistant", text: "回复一" },
    { role: "user", text: "纯字符串轮次" },
    { role: "assistant", text: "content 字段也算" },
  ]);
});

test("装配输出：时间正序 + [role] 前缀", () => {
  const out = assembleContext([
    { role: "user", text: "问题一" },
    { role: "assistant", text: "回答一" },
    { role: "user", text: "问题二" },
  ]);
  assert.equal(out, "[user] 问题一\n[assistant] 回答一\n[user] 问题二");
});

test("maxMessages 截断：只保留最近 N 条", () => {
  const turns = [];
  for (let i = 1; i <= 10; i += 1) turns.push({ role: "user", text: "轮次" + i });
  const out = assembleContext(turns, { maxMessages: 3 });
  assert.ok(!out.includes("轮次7"), "旧轮次应被丢弃");
  assert.equal(out, "[user] 轮次8\n[user] 轮次9\n[user] 轮次10");
});

test("预算从新到旧：字符预算耗尽时旧的整条放弃，输出仍正序", () => {
  const turns = [
    { role: "user", text: "A".repeat(3000) },
    { role: "assistant", text: "B".repeat(900) },
    { role: "user", text: "最新" },
  ];
  const out = assembleContext(turns, { maxChars: 1000 });
  // 最新一条 2+7=9 字符内可容；下一条 900+ 前缀+换行超出剩余预算 → 停止
  assert.ok(out.startsWith("[assistant] "), "应保留到倒数第二条为止");
  assert.ok(out.endsWith("最新"), "最新一条必须完整保留");
  assert.ok(!out.includes("AAAA"), "最旧一条应被整条放弃");
});

test("最新一条独超预算：保留尾部并以 … 标记", () => {
  const out = assembleContext([{ role: "user", text: "x".repeat(5000) }], { maxChars: 100 });
  assert.ok(out.startsWith("…"), "截断应以 … 开头");
  const cp = [...out].length;
  assert.ok(cp <= 101, `保尾长度应 ≤ 101，实际 ${cp}`);
  assert.ok(out.endsWith("xxxx"), "应保留尾部而非头部");
});

test("默认预算生效：不传 opts 时用 8 条 / 4000 字", () => {
  const turns = [];
  for (let i = 1; i <= 12; i += 1) turns.push({ role: "user", text: "轮次" + i });
  const out = assembleContext(turns);
  assert.ok(out.includes("轮次12") && !out.includes("轮次4"), "默认保留最近 8 条（5~12）");
  assert.ok(!out.includes("轮次4"), "第 4 条及更旧应被丢弃");
});

test("中文按 code point 计数：CJK 不被双倍计", () => {
  const out = assembleContext([{ role: "user", text: "汉".repeat(50) }], { maxChars: 60 });
  assert.equal(out, "[user] " + "汉".repeat(50), "50 个汉字应完整保留在 60 预算内");
});
