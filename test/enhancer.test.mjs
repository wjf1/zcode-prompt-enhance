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

/* ---------------- timeout 回落标记（v0.3.0 T07） ----------------
 * 桥层的回落白名单原先包含 timeout，于是"超时后整包重发"会烧双份额度。
 * 判据是 hadFirstChunk：一个 token 都没吐才值得重试。 */

test("超时且无任何 text delta → hadFirstChunk === false（可安全回落）", async () => {
  // stallAfter: 0 = 一个事件都没读出来就卡住
  const res = sseResponse(textEvents(["a"]), { stallAfter: 0 });
  await assert.rejects(
    () => enhanceDraft({ route: ROUTE, draft: "x", fetchImpl: async () => res, timeoutMs: 800 }),
    (e) => {
      assert.equal(e.code, "timeout");
      assert.equal(e.hadFirstChunk, false, "没有 delta 时必须标记为 false，否则不该回落");
      return true;
    }
  );
});

test("先吐 delta 再超时 → hadFirstChunk === true（不得回落）", async () => {
  // stallAfter: 2 = 已读 message_start + 一个 text_delta 后卡住
  const res = sseResponse(textEvents(["第一段", "第二段"]), { stallAfter: 2 });
  await assert.rejects(
    () => enhanceDraft({ route: ROUTE, draft: "x", fetchImpl: async () => res, timeoutMs: 900 }),
    (e) => {
      assert.equal(e.code, "timeout");
      assert.equal(e.hadFirstChunk, true, "已产生内容说明上游已计费，不能回落重发");
      return true;
    }
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

/* ---------------- v0.5.0：强度/场景透传与质量判定 ---------------- */

test("强度与场景透传到 system prompt", async () => {
  let captured = null;
  await enhanceDraft({
    route: ROUTE,
    draft: "帮我修一个 bug 的代码，函数返回 undefined",
    intensity: "deep",
    // 场景由主进程（inject-main.cjs）按草稿判定后显式传入，enhancer 只负责拼装
    scene: "code",
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return sseResponse(textEvents(["请定位并修复该函数返回 undefined 的问题，并补充覆盖空输入与越界输入的测试"]));
    },
  });
  assert.ok(/Depth setting: deep/.test(captured.system), "deep 档必须进 system prompt");
  assert.ok(/Scene setting: code work/.test(captured.system), "传 scene=code 时必须追加代码场景段");
});

test("默认参数下 system prompt 不含任何档位段", async () => {
  let captured = null;
  await enhanceDraft({
    route: ROUTE,
    draft: "帮我写个排序函数",
    fetchImpl: async (url, init) => {
      captured = JSON.parse(init.body);
      return sseResponse(textEvents(["请实现一个稳定的排序函数，接收数组并返回升序结果"]));
    },
  });
  assert.ok(!/Depth setting/.test(captured.system));
  assert.ok(!/Scene setting/.test(captured.system));
});

test("质量判定：模型原样返回时抛 not-changed", async () => {
  const draft = "帮我写个排序函数";
  await assert.rejects(
    () =>
      enhanceDraft({
        route: ROUTE,
        draft,
        fetchImpl: async () => sseResponse(textEvents([draft])),
      }),
    (e) => e instanceof EnhanceError && e.code === "not-changed"
  );
});

test("质量判定：输出停在冒号时抛 truncated", async () => {
  await assert.rejects(
    () =>
      enhanceDraft({
        route: ROUTE,
        draft: "帮我写个排序函数",
        fetchImpl: async () => sseResponse(textEvents(["请实现一个稳定的排序函数，要求如下："])),
      }),
    (e) => e instanceof EnhanceError && e.code === "truncated"
  );
});

test("质量判定：缩水只作为警告随成功结果回传", async () => {
  const draft =
    "请帮我写一个函数，这个函数需要接收一个数组作为输入，返回排序后的结果，要求稳定排序，并且要处理空数组和单元素数组的边界情况，性能上希望是 O(n log n)";
  const out = await enhanceDraft({
    route: ROUTE,
    draft,
    fetchImpl: async () => sseResponse(textEvents(["写个排序函数"])),
  });
  assert.equal(out.text, "写个排序函数");
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].code, "shrunk");
});

test("质量判定可关闭：qualityCheck=false 时不拦未改动", async () => {
  const draft = "帮我写个排序函数";
  const out = await enhanceDraft({
    route: ROUTE,
    draft,
    qualityCheck: false,
    fetchImpl: async () => sseResponse(textEvents([draft])),
  });
  assert.equal(out.text, draft);
});

test("正常增强结果不被质量判定误杀", async () => {
  const out = await enhanceDraft({
    route: ROUTE,
    draft: "帮我写个排序函数",
    fetchImpl: async () =>
      sseResponse(textEvents(["请实现一个稳定的排序函数，接收数组并返回升序结果，同时处理空数组与单元素数组的边界情况"])),
  });
  assert.ok(out.text.includes("稳定"));
  assert.equal(out.warnings ?? null, null, "正常结果不应带警告");
});

test("新增质量错误码都可重试，且带中文文案", () => {
  for (const code of ["not-changed", "truncated", "shrunk"]) {
    const d = describeError(code);
    assert.equal(d.code, code);
    assert.equal(d.retryable, true, `${code} 应为可重试（换个采样可能就好了）`);
    assert.ok(d.zh.length > 0, `${code} 必须有中文文案`);
  }
});
