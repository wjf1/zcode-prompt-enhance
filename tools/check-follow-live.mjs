// 真实链路验证：不同会话模型标签 → 路由到不同 provider/model → 真的能调通。
//
// 用真实 provider_config.json，逐个标签解析路由并发一次真实请求。
// 只发极短草稿（max_tokens 小），成本可控。
import { loadProviderConfig, resolveRoute, listRoutes } from "../core/provider.mjs";

const cfg = loadProviderConfig();
if (!cfg) {
  console.error("provider_config.json 读不到");
  process.exit(1);
}

const routes = listRoutes(cfg);
console.log("可用路由：");
for (const r of routes) {
  console.log("  -", r.providerName, "|", r.baseUrl, "| models:", r.models.length);
}

// 用真实存在的 aria-label 形状构造标签
const LABELS = [];
for (const r of routes) {
  for (const m of r.models.slice(0, 2)) {
    LABELS.push(r.providerName + "/" + m + " 最高");
  }
}

console.log("\n=== 路由解析 ===");
let fail = 0;
const resolved = [];
for (const label of LABELS) {
  const r = resolveRoute(cfg, { sessionModelLabel: label });
  if (!r) {
    console.log("MISS", JSON.stringify(label), "→ (null，将回落默认)");
    continue;
  }
  const ok = r.source === "follow-session";
  console.log((ok ? "OK  " : "FALL"), JSON.stringify(label), "→", r.providerName + " / " + r.model, "[" + r.source + "]");
  if (!ok) fail++;
  resolved.push({ label, route: r });
}

console.log("\n=== 真实调用（每个路由一次，极短草稿）===");
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 120000);
try {
  for (const { label, route } of resolved.slice(0, 4)) {
    const t0 = Date.now();
    try {
      const res = await fetch(route.baseUrl + "/messages", {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": route.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: route.model,
          max_tokens: 24,
          messages: [{ role: "user", content: "回复两个字：可用" }],
        }),
      });
      const text = await res.text();
      const ok = res.ok;
      console.log((ok ? "PASS" : "FAIL"), "HTTP", res.status, "|", route.model, "|", Date.now() - t0 + "ms");
      if (!ok) {
        console.log("       ", text.slice(0, 160));
        fail++;
      }
    } catch (e) {
      console.log("FAIL", route.model, "|", e.name, e.message);
      fail++;
    }
  }
} finally {
  clearTimeout(timer);
}

console.log("\n" + (fail === 0 ? "ALL PASS" : fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
