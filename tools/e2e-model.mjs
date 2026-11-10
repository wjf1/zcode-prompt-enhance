// 端到端：真实 provider → SSE 流式 → 清洗。验证 TextDecoder 修复在真实环境有效。
//
// 用法：
//   node tools/e2e-model.mjs             默认链路验证（两例草稿，standard 档）
//   node tools/e2e-model.mjs --compact   形态验收：对标 WorkBuddy 的膨胀比与单段形态
//
// --compact 是 v0.6.0 的真机验收工具：换模型或调阈值后重跑，
// 验收线 = 基准稿输出 ≤ 800 字符、无小节标题、语言一致。
import { loadProviderConfig, resolveRoute } from "../core/provider.mjs";
import { enhanceDraft } from "../core/enhancer.mjs";

const compactMode = process.argv.includes("--compact");

const cfg = loadProviderConfig();
if (!cfg) {
  console.error("provider_config.json 读不到");
  process.exit(1);
}
const route = resolveRoute(cfg, { provider: "new-provider-4", model: "cn:deepseek-v4.1-flash" });
if (!route) {
  console.error("no route");
  process.exit(1);
}
console.log("route:", route.providerName, "/", route.model);

/* 形态验收基准稿：36 字（WorkBuddy 实测输出约 130 字 / 3.6x 的同一输入）
 * 与 8 字极短稿（验证"短稿一句变一两句"的指引不被 2-4x 卡死）。 */
const COMPACT_CASES = [
  "将我的项目跟其它项目进行全功能前后端对比，哪些值得在我项目上进行迭代升级",
  "帮我写个排序函数",
];

const drafts = compactMode ? COMPACT_CASES : [
  "帮我把这个函数改快一点",
  "write a function that reads a csv file",
];

let failures = 0;
for (const draft of drafts) {
  const t0 = Date.now();
  try {
    let progressCount = 0;
    const out = await enhanceDraft({
      route,
      draft,
      intensity: "standard",
      timeoutMs: 60000,
      onProgress: () => { progressCount += 1; },
    });
    const n = [...draft].length;
    const m = [...out.text].length;
    console.log("\n=== draft:", draft);
    console.log("elapsed:", Date.now() - t0, "ms; stream chunks:", progressCount);
    console.log("usage:", JSON.stringify(out.usage));
    console.log("--- enhanced ---");
    console.log(out.text);
    console.log("--- end ---");
    console.log(`膨胀比: ${n} → ${m} 字 (${(m / n).toFixed(1)}x)`);
    const langOK = /[\u4e00-\u9fff]/.test(draft) === /[\u4e00-\u9fff]/.test(out.text);
    console.log("语言一致:", langOK ? "OK" : "MISMATCH");
    if (compactMode) {
      const hasHeaders = /^#{1,6}\s|^\s*[-*]\s|^\s*\d+[.、)]/m.test(out.text);
      const ok = m <= 800 && !hasHeaders && langOK;
      console.log(`形态验收: ${ok ? "PASS" : "FAIL"}（≤800 字符 ${m <= 800 ? "✓" : "✗"} / 无小节标题与列表 ${hasHeaders ? "✗" : "✓"} / 语言一致 ${langOK ? "✓" : "✗"}）`);
      if (!ok) failures += 1;
    }
  } catch (e) {
    console.error("\n=== draft:", draft, "FAILED");
    console.error(e.name, e.code, e.message);
    if (compactMode) failures += 1;
  }
}
if (compactMode && failures) {
  console.error(`\n${failures} 例未过形态验收`);
  process.exit(1);
}
