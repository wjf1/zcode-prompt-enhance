/**
 * 三闸门：失败熔断 → 滑动窗口限流 → 并发上限。
 *
 * 顺序是刻意设计的：
 *  1) 熔断先判：对持续失败的模型，滑动窗口只统计成功调用，若不熔断，
 *     重试次数只受并发上限约束（几乎无限）。
 *  2) 限流只统计成功调用：统计"尝试"会让一串超时把用户额度烧光，
 *     并在模型恢复时把用户锁死。
 *  3) 并发最后判：槽位释放时间不可预测，所以 429 不带 Retry-After。
 */

export function createGates(opts = {}) {
  const failLimit = opts.failLimit ?? 3;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const windowMs = opts.windowMs ?? 60_000;
  const windowLimit = opts.windowLimit ?? 10;
  const concurrency = opts.concurrency ?? 2;
  const now = opts.now ?? (() => Date.now());

  let failStreak = 0;
  let cooldownUntil = 0;
  let concurrent = 0;
  const successes = []; // 成功调用的时间戳

  function pruneSuccesses(t) {
    while (successes.length && t - successes[0] >= windowMs) successes.shift();
  }

  /** 纯查询，不占槽位。 */
  function check() {
    const t = now();
    if (cooldownUntil > t) {
      return { ok: false, code: "cooldown", retryAfterMs: cooldownUntil - t };
    }
    pruneSuccesses(t);
    if (successes.length >= windowLimit) {
      const oldest = successes[0];
      return { ok: false, code: "rate-limit", retryAfterMs: Math.max(1000, windowMs - (t - oldest)) };
    }
    if (concurrent >= concurrency) {
      // 不带 retryAfter：槽位释放时间不可预测
      return { ok: false, code: "concurrency", retryAfterMs: null };
    }
    return { ok: true };
  }

  /** 占一个并发槽位；返回释放函数。 */
  function acquire() {
    concurrent += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      concurrent = Math.max(0, concurrent - 1);
    };
  }

  function recordSuccess() {
    successes.push(now());
    failStreak = 0;
  }

  function recordFailure({ callerAborted = false } = {}) {
    // 调用方主动取消不计入失败
    if (callerAborted) return;
    failStreak += 1;
    if (failStreak >= failLimit) {
      cooldownUntil = now() + cooldownMs;
      failStreak = 0;
    }
  }

  function snapshot() {
    const t = now();
    pruneSuccesses(t);
    return {
      failStreak,
      coolingDownMs: Math.max(0, cooldownUntil - t),
      successCountInWindow: successes.length,
      concurrent,
      windowLimit,
      concurrency,
    };
  }

  return { check, acquire, recordSuccess, recordFailure, snapshot };
}
