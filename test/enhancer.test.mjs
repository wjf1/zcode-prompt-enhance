import test from "node:test";
import assert from "node:assert/strict";
import {
  enhanceDraft,
  EnhanceError,
  classifyHttpError,
  extractText,
  describeError,
} from "../core/enhancer.mjs";

const ROUTE = { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "test-key", model: "cn:model-a" };

/** 造一个可控的 SSE 响应体，支持"卡住不 yield"以测试超时。 */
function sseResponse(events, { stallAfter = Infinity, delayMs = 0 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const body = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (i >= stallAfter) return new Promise(() => {}); // 永远不 settle
          if (i >= events.length) return Promise.resolve({ done: true, value: undefined });
          const evt = events[i++];
          const chunk = encoder.encode(`data: ${JSON.stringify(evt)}\n\n`);
          if (delayMs) return new Promise((r) => setTimeout(() => r({ done: false, value: chunk }), delayMs));
          return Promise.resolve({ done: false, value: chunk });
        },
        return() {
          body.__closed = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return { ok: true, status: 200, body, __body: body };
}

function textEvents(parts, stopReason = "end_turn") {
  const evts = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    ...parts.map((p) => ({ type: "content_block_delta", delta: { type: "text_delta", text: p } })),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
  ];
  return evts;
}

test("成功路径：SSE 拼出完整文本并清洗", async () => {
  const res = sseResponse(textEvents(["```text\n", "请解释代码", "\n```"]));
  const out = await enhanceDraft({
    route: ROUTE,
    draft: "解释代码",
    fetchImpl: async () => res,
  });
  assert.equal(out.text, "请解释代码");
  assert.equal(out.usage.input_tokens, 10);
});

test("请求体：system 走顶层，messages 只有一条 user，且 stream=true", async () => {
  let captured = null;
  const res = sseResponse(textEvents(["ok"]));
  await enhanceDraft({
    route: ROUTE,
    draft: "你好",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return res;
    },
  });
  assert.equal(captured.url, "http://127.0.0.1:9999/v1/messages");
  assert.equal(captured.init.headers["x-api-key"], "test-key");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.stream, true);
  assert.ok(body.system.includes("expert prompt engineer"));
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.ok(body.messages[0].content.includes("<raw_prompt>"));
  assert.equal(body.model, "cn:model-a");
});

test("空草稿直接拒绝，不发请求", async () => {
  let called = false;
  await assert.rejects(
    () => enhanceDraft({ route: ROUTE, draft: "   ", fetchImpl: async () => { called = true; } }),
    (e) => e instanceof EnhanceError && e.code === "empty"
  );
  assert.equal(called, false);
});

test("无路由 → unsupported", async () => {
  await assert.rejects(
    () => enhanceDraft({ route: null, draft: "x" }),
    (e) => e instanceof EnhanceError && e.code === "unsupported"
  );
});

test("超时：不仅停止等待，还要关闭上游流", async () => {
  const res = sseResponse(textEvents(["a", "b"]), { stallAfter: 1 });
  const t0 = Date.now();
  await assert.rejects(
    () => enhanceDraft({ route: ROUTE, draft: "x", fetchImpl: async () => res, timeoutMs: 1200 }),
    (e) => e instanceof EnhanceError && e.code === "timeout"
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `超时应快速返回，实际 ${elapsed}ms`);
  // 给 finally 里的 return() 一点时间落定
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(res.__body.__closed, true, "上游流必须被显式关闭，否则继续计费");
});

test("调用方 abort → aborted，不计超时", async () => {
  const res = sseResponse(textEvents(["a"]), { stallAfter: 0 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(
    () => enhanceDraft({ route: ROUTE, draft: "x", fetchImpl: async () => res, signal: ac.signal, timeoutMs: 30_000 }),
    (e) => e instanceof EnhanceError && e.code === "aborted"
  );
});

test("401 → auth", async () => {
  await assert.rejects(
    () => enhanceDraft({
      route: ROUTE,
      draft: "x",
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }),
    }),
    (e) => e.code === "auth"
  );
});

test("429 + quota 字样 → quota", async () => {
  await assert.rejects(
    () => enhanceDraft({
      route: ROUTE,
      draft: "x",
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{"error":"quota exceeded"}' }),
    }),
    (e) => e.code === "quota"
  );
});

test("finish_reason = max_tokens → max-tokens", async () => {
  const res = sseResponse(textEvents(["半截"], "max_tokens"));
  await assert.rejects(
    () => enhanceDraft({ route: ROUTE, draft: "x", fetchImpl: async () => res }),
    (e) => e.code === "max-tokens"
  );
});

test("响应含 tool_use → tool-call", async () => {
  const evts = [
    { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "x" } },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
  ];
  await assert.rejects(
    () => enhanceDraft({ route: ROUTE, draft: "x", fetchImpl: async () => sseResponse(evts) }),
    (e) => e.code === "tool-call"
  );
});

test("清洗后为空 → empty", async () => {
  const res = sseResponse(textEvents(["   "]));
  await assert.rejects(
    () => enhanceDraft({ route: ROUTE, draft: "x", fetchImpl: async () => res }),
    (e) => e.code === "empty"
  );
});

test("非流式退路：上游忽略 stream 也能取到文本", async () => {
  const res = {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: "text", text: "请解释代码" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3 },
    }),
  };
  const out = await enhanceDraft({ route: ROUTE, draft: "x", fetchImpl: async () => res });
  assert.equal(out.text, "请解释代码");
});

test("流式 error 事件被归一化", async () => {
  const evts = [{ type: "error", error: { type: "overloaded_error", message: "busy" } }];
  await assert.rejects(
    () => enhanceDraft({ route: ROUTE, draft: "x", fetchImpl: async () => sseResponse(evts) }),
    (e) => e instanceof EnhanceError && e.code === "internal"
  );
});

test("classifyHttpError 覆盖主要分支", () => {
  assert.equal(classifyHttpError(401, ""), "auth");
  assert.equal(classifyHttpError(403, ""), "auth");
  assert.equal(classifyHttpError(413, ""), "too-long");
  assert.equal(classifyHttpError(429, "rate limit"), "rate-limit");
  assert.equal(classifyHttpError(429, "insufficient balance"), "quota");
  assert.equal(classifyHttpError(400, "context_length_exceeded"), "context-window");
  assert.equal(classifyHttpError(500, ""), "internal");
});

test("extractText 忽略非文本块", () => {
  assert.equal(
    extractText([
      { type: "thinking", thinking: "..." },
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "ab"
  );
  assert.equal(extractText(null), "");
});

test("describeError 未知码回落 internal", () => {
  assert.equal(describeError("nope").code, "internal");
  assert.equal(describeError("timeout").retryable, true);
  assert.equal(describeError("auth").retryable, false);
});
