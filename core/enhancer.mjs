/**
 * 模型调用：Anthropic Messages 兼容协议。
 *
 * 关键工程点（两版参考实现共同踩过的坑）：
 *  - 超时不能只 race 外层 Promise：一个不 yield 的读取器会挂死，必须对
 *    iterator.next() 逐次竞速。
 *  - 超时/取消后必须 iterator.return()：否则上游流仍活着、继续产生 token、
 *    照旧计费。
 *  - 失败判定包含 finish_reason === 'max_tokens'、响应含 tool_use、清洗后为空。
 */

import { buildSystemPrompt, frameUserPrompt, cleanEnhancedText } from "./prompt.mjs";
import { assessQuality } from "./quality.mjs";

export const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_OUTPUT_TOKENS = 2048;
export const TEMPERATURE = 0.3;

/** 错误码归一化表。retryable 供 UI 决定是否给"重试"按钮。 */
export const ERROR_CODES = {
  auth: { status: 502, retryable: false, zh: "鉴权失败，请检查模型配置" },
  "invalid-credential": { status: 502, retryable: false, zh: "模型凭据无效" },
  "rate-limit": { status: 502, retryable: true, zh: "请求过于频繁，请稍后重试" },
  quota: { status: 502, retryable: false, zh: "额度已用尽" },
  empty: { status: 502, retryable: true, zh: "模型返回了空内容" },
  "context-window": { status: 502, retryable: false, zh: "输入超出模型上下文上限" },
  "max-tokens": { status: 502, retryable: true, zh: "输出被截断，请缩短输入后重试" },
  "tool-call": { status: 502, retryable: true, zh: "模型返回了非预期的工具调用" },
  timeout: { status: 504, retryable: true, zh: "请求超时" },
  aborted: { status: 499, retryable: false, zh: "已取消" },
  "too-long": { status: 413, retryable: false, zh: "草稿过长，请精简后重试" },
  "not-changed": { status: 502, retryable: true, zh: "模型没有产生实质改动，请重试" },
  truncated: { status: 502, retryable: true, zh: "输出不完整（结尾被截断），请重试" },
  shrunk: { status: 502, retryable: true, zh: "增强结果比原文更简短，可能丢失信息" },
  unsupported: { status: 503, retryable: false, zh: "当前没有可用的增强模型配置" },
  internal: { status: 502, retryable: true, zh: "增强失败，请稍后重试" },
};

export function describeError(code) {
  const e = ERROR_CODES[code] || ERROR_CODES.internal;
  return { code: code in ERROR_CODES ? code : "internal", status: e.status, retryable: e.retryable, zh: e.zh };
}

export class EnhanceError extends Error {
  constructor(code, detail) {
    super(detail || describeError(code).zh);
    this.name = "EnhanceError";
    this.code = code in ERROR_CODES ? code : "internal";
    this.detail = detail || "";
  }
}

/** 从上游 HTTP 状态 + 响应体推断错误码。 */
export function classifyHttpError(status, bodyText) {
  const t = String(bodyText || "").toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status === 429) {
    if (t.includes("quota") || t.includes("insufficient") || t.includes("balance")) return "quota";
    return "rate-limit";
  }
  if (status === 413) return "too-long";
  if (t.includes("context_length") || t.includes("context window") || t.includes("too many tokens")) {
    return "context-window";
  }
  if (t.includes("invalid api key") || t.includes("invalid x-api-key")) return "invalid-credential";
  if (t.includes("quota") || t.includes("insufficient balance")) return "quota";
  return "internal";
}

/** 从响应体里抽出文本内容块（忽略 thinking 等非文本块）。 */
export function extractText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

export function hasToolUse(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === "tool_use");
}

/**
 * 竞速迭代：一个不 yield 的读取器也必须能被超时命中。
 * 返回 { value, done }，abort 时抛 EnhanceError('aborted')。
 */
async function nextOrAbort(iterator, signal, getAbortCode) {
  if (signal.aborted) throw new EnhanceError(getAbortCode());
  let onAbort = null;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(new EnhanceError(getAbortCode()));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 调用增强模型，返回清洗后的文本。
 *
 * @param {object} opts
 * @param {{baseUrl:string, apiKey:string, model:string}} opts.route
 * @param {string} opts.draft 用户草稿
 * @param {string} [opts.context] 已装配的对话上下文
 * @param {"standard"|"deep"} [opts.intensity] 增强强度档位
 * @param {"code"|"data"|"doc"|"general"} [opts.scene] 场景模板
 * @param {boolean} [opts.qualityCheck] 是否做输出质量判定（默认 true）
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl] 便于测试注入
 * @returns {Promise<{text:string, usage?:object, warnings?:object[]}>}
 */
export async function enhanceDraft({
  route,
  draft,
  context,
  intensity,
  scene,
  qualityCheck = true,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  onProgress,
}) {
  if (!route || !route.baseUrl || !route.apiKey || !route.model) {
    throw new EnhanceError("unsupported");
  }
  const text = String(draft ?? "");
  if (text.trim() === "") throw new EnhanceError("empty", "草稿为空");

  const hasContext = typeof context === "string" && context !== "";
  const sys = buildSystemPrompt(hasContext, { intensity, scene });
  const userMsg = frameUserPrompt(text, hasContext ? context : undefined);

  const ac = new AbortController();
  const outerSignal = signal;
  let abortedByOuter = false;
  if (outerSignal) {
    if (outerSignal.aborted) throw new EnhanceError("aborted");
    outerSignal.addEventListener(
      "abort",
      () => {
        abortedByOuter = true;
        ac.abort();
      },
      { once: true }
    );
  }
  const timer = setTimeout(() => ac.abort(), Math.max(1000, timeoutMs));

  let iterator = null;
  let exhausted = false;
  /* 是否已经收到过文本增量。用于桥层判断"超时是否值得回落重试"：
   * 一个 token 都没吐 → 上游大概率没计费，重试安全；
   * 已经吐了内容才超时 → 上游早已产出并计费，再整发包 = 一次点击烧双份额度。 */
  let sawDelta = false;

  try {
    const res = await fetchImpl(route.baseUrl + "/messages", {
      method: "POST",
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": route.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: route.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: TEMPERATURE,
        system: sys,
        messages: [{ role: "user", content: userMsg }],
        stream: true,
      }),
    });

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {}
      throw new EnhanceError(classifyHttpError(res.status, body), `HTTP ${res.status}`);
    }

    // ---- SSE 解析 ----
    const chunks = [];
    let finishReason = null;
    const toolBlocks = [];
    const usage = {};

    if (res.body && typeof res.body[Symbol.asyncIterator] === "function") {
      iterator = res.body[Symbol.asyncIterator]();
      /* 用 TextDecoder 而不是 String(chunk)：undici 的 fetch 给的是 Uint8Array，
         String(uint8) 会得到 "1,2,3" 这样的字节列表，SSE 一行都切不出来。
         stream:true 让跨 chunk 的多字节汉字不被截断成乱码。 */
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      for (;;) {
        const step = await nextOrAbort(iterator, ac.signal, () => (abortedByOuter ? "aborted" : "timeout"));
        if (step.done) {
          exhausted = true;
          buffer += decoder.decode();
          break;
        }
        buffer += typeof step.value === "string" ? step.value : decoder.decode(step.value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          let evt;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
            toolBlocks.push(evt.content_block);
          }
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            sawDelta = true;
            chunks.push(evt.delta.text || "");
            if (onProgress) {
              try { onProgress(chunks.join("")); } catch {}
            }
          }
          if (evt.type === "message_delta") {
            if (evt.delta?.stop_reason) finishReason = evt.delta.stop_reason;
            if (evt.usage) Object.assign(usage, evt.usage);
          }
          if (evt.type === "message_start" && evt.message?.usage) {
            Object.assign(usage, evt.message.usage);
          }
          if (evt.type === "error") {
            const code = classifyHttpError(500, JSON.stringify(evt.error || {}));
            throw new EnhanceError(code, JSON.stringify(evt.error || {}).slice(0, 300));
          }
        }
      }
    } else {
      // 非流式退路（上游忽略 stream:true 时）
      const body = await res.json();
      if (hasToolUse(body.content)) throw new EnhanceError("tool-call");
      chunks.push(extractText(body.content));
      finishReason = body.stop_reason || null;
      Object.assign(usage, body.usage || {});
      exhausted = true;
    }

    const raw = chunks.join("");
    if (toolBlocks.length > 0) throw new EnhanceError("tool-call");
    if (finishReason === "max_tokens") throw new EnhanceError("max-tokens");
    const cleaned = cleanEnhancedText(raw);
    if (cleaned === "") throw new EnhanceError("empty");

    /* 输出质量判定：把"点了没变化 / 输出断在半句 / 信息量缩水"
     * 从模糊的 empty（或干脆静默通过）变成可归因的结果。
     * 阻断级问题抛 EnhanceError，让 UI 走既有错误通道；
     * 警告级问题随成功结果一起回传，由浮层决定是否提示。 */
    if (qualityCheck) {
      const { blocking, warnings } = assessQuality(text, cleaned);
      if (blocking) throw new EnhanceError(blocking.code, blocking.detail);
      if (warnings.length) return { text: cleaned, usage, warnings };
    }
    return { text: cleaned, usage };
  } catch (err) {
    if (err instanceof EnhanceError) {
      /* 超时通常是 nextOrAbort 竞速时抛出的 EnhanceError("timeout")（ac.abort 触发），
         它在上面就已经是 EnhanceError 了，会走到这一支 —— 标记必须在这里补，
         只挂在下面的 AbortError 分支会漏掉最常见的超时路径。 */
      if (err.code === "timeout" || err.code === "aborted") err.hadFirstChunk = sawDelta;
      throw err;
    }
    // AbortController 触发的异常：区分超时/调用方取消
    if (err && (err.name === "AbortError" || ac.signal.aborted)) {
      const e = new EnhanceError(abortedByOuter ? "aborted" : "timeout");
      // 供桥层决定是否值得回落：只有"一个 token 都没吐"才不心疼重发
      e.hadFirstChunk = sawDelta;
      throw e;
    }
    throw new EnhanceError("internal", String((err && err.message) || err));
  } finally {
    clearTimeout(timer);
    // 挂起的 next() 永不 settle，循环退出时迭代器未被耗尽：
    // 必须显式催底层流 finalize，否则上游继续产 token、照旧计费。
    if (iterator && !exhausted) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {}
    }
  }
}
