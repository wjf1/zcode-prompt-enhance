// 验证「实时跟随会话模型」的可行性：能否从 DOM 的 aria-label 反查到可用的 provider 路由。
//
// 不解析模型名（模型 id 本身可能含 "/"，如 meta/muse-spark-1.3），
// 改用「已知模型 id 是否被 aria-label 包含」的匹配法 —— 对 DOM 结构变化更不敏感。
import { loadProviderConfig, listRoutes } from "../core/provider.mjs";

const cfg = loadProviderConfig();
if (!cfg) {
  console.error("provider_config.json 读不到");
  process.exit(1);
}
const routes = listRoutes(cfg);

// 来自 2026-10-26 真机探针的实测 aria-label
const REAL_ARIAS = [
  "workbuddy代理/cn:deepseek-v4.1-flash 最高",
  "mikasaapi/gpt-5.6-terra 最高",
  "cmcode/deepseek/deepseek-v4.1-flash 最高",
  "cmcode/meta/muse-spark-1.3-contributor 高",
];

function matchByContainment(aria) {
  const hits = [];
  for (const r of routes) {
    for (const m of r.models) {
      if (aria.includes(m)) hits.push({ providerName: r.providerName, providerId: r.providerId, model: m, len: m.length });
    }
  }
  if (!hits.length) return null;
  // 取最长匹配，避免 "gpt-6" 与 "gpt-6-astra" 这类前缀包含造成误判
  hits.sort((a, b) => b.len - a.len);
  const best = hits[0];
  // 若存在等长的多个不同模型 → 歧义，放弃
  const tied = hits.filter((h) => h.len === best.len && h.model !== best.model);
  if (tied.length) return { ambiguous: true, hits: hits.map((h) => h.model) };
  return best;
}

let fail = 0;
let matched = 0;
for (const aria of REAL_ARIAS) {
  const r = matchByContainment(aria);
  if (r && r.model) {
    matched++;
    console.log("OK   ", JSON.stringify(aria), "→", r.providerName + " / " + r.model);
  } else if (r && r.ambiguous) {
    console.log("AMBIG", JSON.stringify(aria), "→", JSON.stringify(r.hits));
    fail++;
  } else {
    console.log("MISS ", JSON.stringify(aria), "→ 无法匹配（应回落到 config 默认）");
  }
}

console.log("\n可用路由数:", routes.length);
console.log("可匹配样本:", matched + "/" + REAL_ARIAS.length);
console.log(fail === 0 ? "=> 匹配法可行（歧义样本 " + fail + " 个）" : "=> 存在歧义，需要额外判据");
