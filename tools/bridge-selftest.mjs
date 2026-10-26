// 在不重启 ZCode 的前提下，验证 inject-main.cjs 的核心逻辑：
// 本地 HTTP 桥 + provider 路由 + SSE 流式回推 + 错误码。
//
// 做法：把 inject-main 里与 Electron 无关的部分（桥服务、路由、闸门）抽出来跑，
// 用一个假的 electron 模块满足 require。这样注入前的失败都在这里暴露，
// 不必冒险改 asar。
import http from "node:http";
import crypto from "node:crypto";
import { loadProviderConfig, resolveRoute, findConfig } from "../core/provider.mjs";
import { enhanceDraft } from "../core/enhancer.mjs";
import { createGates } from "../core/gates.mjs";

const TOKEN = crypto.randomBytes(16).toString("hex");
const gates = createGates();
let port = 0;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { code: "too-long" }));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

const MAX_INPUT = 12000;
const found = findConfig();
const cfg = found.parsed;
const route = resolveRoute(cfg, { provider: "new-provider-2", model: "cn:deepseek-v4.1-flash" });

const server = http.createServer(async (req, res) => {
  /* 与 inject-main.cjs 同序：先 Host 校验（防 DNS rebinding），再 token 校验。
     正常调用用的是 http://127.0.0.1:<port>，Host 头自然是 127.0.0.1:<port>。 */
  const host = String(req.headers.host || "");
  if (port && host !== "127.0.0.1:" + port && host !== "localhost:" + port) {
    return json(res, 403, { code: "forbidden" });
  }
  if (req.headers["x-zpe-token"] !== TOKEN) return json(res, 403, { code: "forbidden" });
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      model: route?.model,
      provider: route?.providerName,
      maxInputChars: MAX_INPUT,
      configPath: found.path,
      configShape: found.shape,
    });
  }
  if (url.pathname !== "/enhance" || req.method !== "POST") return json(res, 404, { code: "not-found" });

  let payload;
  try {
    payload = JSON.parse(await readBody(req, MAX_INPUT * 6 + 4096));
  } catch (e) {
    return json(res, e.code === "too-long" ? 413 : 400, { code: e.code === "too-long" ? "too-long" : "internal" });
  }

  const draft = typeof payload?.draft === "string" ? payload.draft : "";
  let n = 0;
  for (const _ of draft) n += 1;
  if (n === 0) return json(res, 400, { code: "empty" });
  if (n > MAX_INPUT) return json(res, 413, { code: "too-long", limit: MAX_INPUT, actual: n });

  const gate = gates.check();
  if (!gate.ok) return json(res, 429, { code: "rate-limit" });

  const release = gates.acquire();
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  try {
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    let progressEvents = 0;
    const result = await enhanceDraft({
      route,
      draft,
      signal: ac.signal,
      onProgress: (t) => {
        progressEvents += 1;
        if (!res.writableEnded) res.write(JSON.stringify({ type: "progress", text: t }) + "\n");
      },
    });
    gates.recordSuccess();
    res.write(JSON.stringify({ type: "done", text: result.text, usage: result.usage, progressEvents }) + "\n");
    res.end();
  } catch (err) {
    const code = (err && err.code) || "internal";
    if (code !== "aborted") gates.recordFailure();
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: "error", code }) + "\n");
      res.end();
    }
  } finally {
    release();
  }
});

const listening = new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
port = await listening;
console.log("bridge on 127.0.0.1:" + port);

const base = `http://127.0.0.1:${port}`;
const H = { "content-type": "application/json", "x-zpe-token": TOKEN };

async function call(pathname, body, headers = H) {
  const res = await fetch(base + pathname, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS", name);
  else {
    console.log("  FAIL", name, extra === undefined ? "" : JSON.stringify(extra));
    fail += 1;
  }
}

console.log("\n[1] health");
{
  const r = await call("/health");
  check("200", r.status === 200, r);
  const j = JSON.parse(r.text);
  check("has model", !!j.model, j);
  check("有 configPath 字段（三态诊断）", "configPath" in j, j.configPath);
  check("有 configShape 字段（三态诊断）", ["anthropic-v2", "unknown", "missing"].includes(j.configShape), j.configShape);
  console.log("  configPath:", j.configPath, "shape:", j.configShape);
}

console.log("\n[2] 无 token 被拒");
{
  const r = await call("/health", undefined, {});
  check("403", r.status === 403, r);
}

console.log("\n[3] 错误 token 被拒");
{
  const r = await call("/health", undefined, { "x-zpe-token": "wrong" });
  check("403", r.status === 403, r);
}

console.log("\n[4] 空草稿");
{
  const r = await call("/enhance", { draft: "" });
  check("400 empty", r.status === 400 && r.text.includes("empty"), r);
}

console.log("\n[5] 超长草稿被拒（不截断）");
{
  const r = await call("/enhance", { draft: "字".repeat(MAX_INPUT + 1) });
  check("413 too-long", r.status === 413 && r.text.includes("too-long"), r);
}

console.log("\n[6] 真实增强：流式进度 + done");
{
  const t0 = Date.now();
  const r = await call("/enhance", { draft: "帮我把这个函数改快一点" });
  const lines = r.text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const done = lines.find((l) => l.type === "done");
  const hasProgress = lines.some((l) => l.type === "progress");
  check("200", r.status === 200, r.status);
  check("有 progress 事件", hasProgress, lines.length);
  check("有 done 事件", !!done, lines.slice(-1));
  check("文本非空", !!(done && done.text && done.text.length > 20), done && done.text && done.text.slice(0, 60));
  check("进度事件数 > 10", done && done.progressEvents > 10, done && done.progressEvents);
  console.log("  elapsed", Date.now() - t0, "ms; enhanced len", done && done.text.length);
}

console.log("\n[7] 取消（客户端断开）");
{
  const ac = new AbortController();
  const p = fetch(base + "/enhance", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ draft: "写一个很长很长的详细技术文档说明" }),
    signal: ac.signal,
  }).catch(() => null);
  setTimeout(() => ac.abort(), 600);
  await p;
  console.log("  PASS 客户端已断开（上游应被 abort）");
}

console.log("\n[8] 非回环 Host 被拒（防 DNS rebinding）");
{
  /* 必须用 node:http 发原始请求：fetch（undici）把 Host 当作禁止修改的头，
     传了也会被忽略，那样断言就成了"没设 Host 的普通请求"，测不到东西。 */
  const raw = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/health", method: "GET", headers: { host: "evil.example.com", "x-zpe-token": TOKEN } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, text: body }));
      }
    );
    req.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
    req.end();
  });
  check("403 forbidden", raw.status === 403 && raw.text.includes("forbidden"), raw);
}

console.log("\n[9] localhost 形式的 Host 也放行");
{
  const r = await fetch(`http://localhost:${port}/health`, { headers: { "x-zpe-token": TOKEN } }).then(async (res) => ({
    status: res.status,
    text: await res.text(),
  }));
  check("200", r.status === 200, r);
}

server.close();
console.log("\n" + (fail === 0 ? "ALL PASS" : fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
