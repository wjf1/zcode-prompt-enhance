import test from "node:test";
import assert from "node:assert/strict";
import {
  createGates,
} from "../core/gates.mjs";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("正常调用放行", () => {
  const g = createGates();
  assert.equal(g.check().ok, true);
});

test("并发上限：第 3 个请求被拒且不带 retryAfter", () => {
  const g = createGates({ concurrency: 2 });
  const r1 = g.acquire();
  const r2 = g.acquire();
  const res = g.check();
  assert.equal(res.ok, false);
  assert.equal(res.code, "concurrency");
  assert.equal(res.retryAfterMs, null);
  r1();
  assert.equal(g.check().ok, true);
  r2();
});

test("释放是幂等的：重复调用不会把计数打到负数", () => {
  const g = createGates({ concurrency: 2 });
  const r = g.acquire();
  r();
  r();
  r();
  assert.equal(g.snapshot().concurrent, 0);
  assert.equal(g.check().ok, true);
});

test("滑动窗口：成功调用超过上限后被限流，且带精确 retryAfter", () => {
  const clock = fakeClock(0);
  const g = createGates({ windowMs: 60_000, windowLimit: 3, now: clock.now });
  g.recordSuccess();
  clock.advance(10_000);
  g.recordSuccess();
  clock.advance(10_000);
  g.recordSuccess();

  const res = g.check();
  assert.equal(res.ok, false);
  assert.equal(res.code, "rate-limit");
  // 最老的调用在 t=0，窗口 60s，当前 t=20s → 还需 40s
  assert.equal(res.retryAfterMs, 40_000);

  clock.advance(40_000);
  assert.equal(g.check().ok, true, "窗口滑过后恢复");
});

test("限流只统计成功调用：失败不占窗口", () => {
  const g = createGates({ windowLimit: 2 });
  // 只 2 次失败：不触发熔断（熔断要到 3 次），也不占滑动窗口
  g.recordFailure();
  g.recordFailure();
  assert.equal(g.check().ok, true, "连续失败不应把自己限流");
});

test("熔断：连续 3 次失败进入冷却 30s", () => {
  const clock = fakeClock(0);
  const g = createGates({ now: clock.now });
  g.recordFailure();
  g.recordFailure();
  assert.equal(g.check().ok, true);
  g.recordFailure();
  const res = g.check();
  assert.equal(res.ok, false);
  assert.equal(res.code, "cooldown");
  assert.equal(res.retryAfterMs, 30_000);

  clock.advance(30_000);
  assert.equal(g.check().ok, true, "冷却结束后恢复");
});

test("调用方主动取消不计入失败", () => {
  const g = createGates();
  g.recordFailure({ callerAborted: true });
  g.recordFailure({ callerAborted: true });
  g.recordFailure({ callerAborted: true });
  assert.equal(g.check().ok, true);
  assert.equal(g.snapshot().failStreak, 0);
});

test("成功会重置失败连击", () => {
  const g = createGates();
  g.recordFailure();
  g.recordFailure();
  g.recordSuccess();
  g.recordFailure();
  g.recordFailure();
  assert.equal(g.check().ok, true, "成功清零后不该熔断");
});

test("熔断优先于限流判定", () => {
  const clock = fakeClock(0);
  const g = createGates({ windowLimit: 1, now: clock.now });
  g.recordSuccess();
  for (let i = 0; i < 3; i += 1) g.recordFailure();
  const res = g.check();
  assert.equal(res.code, "cooldown", "熔断先判");
});
