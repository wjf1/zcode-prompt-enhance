// 端到端：真实 provider → SSE 流式 → 清洗。验证 TextDecoder 修复在真实环境有效。
import { loadProviderConfig, resolveRoute } from "../core/provider.mjs";
import { enhanceDraft } from "../core/enhancer.mjs";

const cfg = loadProviderConfig();
if (!cfg) {
  console.error("provider_config.json 读不到");
  process.exit(1);
}
const route = resolveRoute(cfg, { provider: "new-provider-2", model: "cn:deepseek-v4.1-flash" });
if (!route) {
  console.error("no route");
  process.exit(1);
}
console.log("route:", route.providerName, "/", route.model);

const drafts = [
  "帮我把这个函数改快一点",
  "write a function that reads a csv file",
];

for (const draft of drafts) {
  const t0 = Date.now();
  try {
    let progressCount = 0;
    const out = await enhanceDraft({
      route,
      draft,
      timeoutMs: 60000,
      onProgress: () => { progressCount += 1; },
    });
    console.log("\n=== draft:", draft);
    console.log("elapsed:", Date.now() - t0, "ms; stream chunks:", progressCount);
    console.log("usage:", JSON.stringify(out.usage));
    console.log("--- enhanced ---");
    console.log(out.text);
    console.log("--- end (len " + out.text.length + ") ---");
    console.log("语言一致:", /[\u4e00-\u9fff]/.test(draft) === /[\u4e00-\u9fff]/.test(out.text) ? "OK" : "MISMATCH");
  } catch (e) {
    console.error("\n=== draft:", draft, "FAILED");
    console.error(e.name, e.code, e.message);
  }
}
