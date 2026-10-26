// 一次性探针：验证 provider_config.json 里的路由能否直连 Anthropic Messages。
// 用法：node tools/probe-model.mjs [providerId] [modelIndex]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CFG = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
const providerId = process.argv[2] || "new-provider-2";
const modelIndex = Number(process.argv[3] || 1);

const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
const rules = cfg?.config?.providerConfigRules?.providerRules || [];
const rule = rules.find((r) => r.providerId === providerId);
if (!rule) {
  console.error("provider not found:", providerId, "available:", rules.map((r) => r.providerId).join(", "));
  process.exit(1);
}
const api = rule.config?.api || {};
const model = (rule.config?.personalModelIds || [])[modelIndex];
if (!model) {
  console.error("no model at index", modelIndex);
  process.exit(1);
}
if (api.type && api.type !== "anthropic-messages") {
  console.error("unsupported api.type:", api.type);
  process.exit(1);
}
const base = String(api.baseUrl || "").replace(/\/+$/, "");
const url = base + "/messages";
console.log("url:", url, "model:", model);

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 30000);
const t0 = Date.now();
try {
  const res = await fetch(url, {
    method: "POST",
    signal: ac.signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": rule.config.access.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 48,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    }),
  });
  const text = await res.text();
  console.log("HTTP", res.status, "in", Date.now() - t0, "ms");
  console.log(text.slice(0, 800));
} catch (e) {
  console.error("ERR after", Date.now() - t0, "ms:", e.name, e.message);
} finally {
  clearTimeout(timer);
}
