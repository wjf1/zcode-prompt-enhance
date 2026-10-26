// 验证「跟随失败 → 自动回落默认路由」的真实行为。
//
// 手法：显式指定一个已知不可用的会话模型（cmcode 额度耗尽），
// 观察：① 是否报错；② 是否自动换到可用路由并成功；③ 回传的 routeSource 是否为 fallback-after-follow。
// 依赖 inject-main 的 /enhance 端点，因此需要 bridge 端口与 token —— 从页面侧拿不到，
// 所以这里直接复刻 inject-main 的回落判定逻辑做等价验证，并额外跑一次真实双路由调用。
import { loadProviderConfig, resolveRoute } from "../core/provider.mjs";
import { enhanceDraft } from "../core/enhancer.mjs";

const cfg = loadProviderConfig();
const FOLLOW_FAILABLE = ["internal", "quota", "auth", "invalid-credential", "rate-limit", "unsupported", "timeout"];

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS", name);
  else {
    console.log("  FAIL", name, extra === undefined ? "" : String(extra));
    fail += 1;
  }
}

console.log("[1] 不可用会话模型（cmcode 额度耗尽）");
const badLabel = "cmcode/meta/muse-spark-1.3-contributor 最高";
const badRoute = resolveRoute(cfg, { sessionModelLabel: badLabel });
console.log("  跟随路由:", badRoute.providerName + "/" + badRoute.model, "[" + badRoute.source + "]");
check("正确跟随到 cmcode", badRoute.source === "follow-session", badRoute.source);

let firstErr = null;
try {
  await enhanceDraft({ route: badRoute, draft: "帮我把这个函数改快一点", timeoutMs: 30000 });
  console.log("  意外成功（该模型本应不可用）");
} catch (e) {
  firstErr = e;
  console.log("  如期失败:", e.code, "|", String(e.detail || e.message).slice(0, 100));
}
check("失败且错误码可回落", !!firstErr && FOLLOW_FAILABLE.includes(firstErr.code), firstErr && firstErr.code);

console.log("\n[2] 回落到默认路由");
const fallback = resolveRoute(cfg, { sessionModelLabel: "", provider: "new-provider-2", model: "cn:deepseek-v4.1-flash" });
console.log("  回落路由:", fallback.providerName + "/" + fallback.model, "[" + fallback.source + "]");
check("回落路由与失败路由不同", fallback.providerId + fallback.model !== badRoute.providerId + badRoute.model);

let ok = false;
try {
  const out = await enhanceDraft({ route: fallback, draft: "帮我把这个函数改快一点", timeoutMs: 60000 });
  ok = !!(out.text && out.text.length > 20);
  console.log("  回落调用成功，返回", out.text.length, "字");
} catch (e) {
  console.log("  回落调用失败:", e.code, String(e.detail || e.message).slice(0, 120));
}
check("回落路由可正常增强", ok);

console.log("\n[3] 可用会话模型（workbuddy）正常跟随，不应触发回落");
const goodLabel = "workbuddy代理/cn:deepseek-v4.1-flash 最高";
const goodRoute = resolveRoute(cfg, { sessionModelLabel: goodLabel });
check("跟随到 workbuddy", goodRoute.source === "follow-session" && goodRoute.providerName === "workbuddy代理", goodRoute.providerName);
let goodOK = false;
try {
  const out = await enhanceDraft({ route: goodRoute, draft: "帮我把这个函数改快一点", timeoutMs: 60000 });
  goodOK = !!(out.text && out.text.length > 20);
  console.log("  跟随调用成功，返回", out.text.length, "字");
} catch (e) {
  console.log("  跟随调用失败:", e.code);
}
check("跟随路由可正常增强", goodOK);

console.log("\n" + (fail === 0 ? "ALL PASS — 跟随与回落两条路径都成立" : fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
