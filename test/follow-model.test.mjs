/**
 * 「实时跟随会话模型」的匹配算法测试。
 *
 * 这是 v0.2.0 的核心新能力：从工具行模型按钮的标签文本反查可用路由。
 * 匹配失败必须安静回落（返回 null），绝不能让增强功能因此失效。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { matchByLabel, resolveRoute } from "../core/provider.mjs";

// 用 2026-10-26 真机实测的 provider 结构构造（模型 id 含 "/" 是真实情况）
const ROUTES = [
  {
    providerId: "new-provider-2",
    providerName: "workbuddy代理",
    apiKey: "k1",
    baseUrl: "http://127.0.0.1:7863/v1",
    models: ["cn:glm-5.3-flash", "cn:deepseek-v4.1-flash", "cn:kimi-k3-1", "cn:glm-5.3"],
  },
  {
    providerId: "f997",
    providerName: "cmcode",
    apiKey: "k2",
    baseUrl: "http://127.0.0.1:9090/v1",
    models: ["meta/muse-spark-1.3-contributor", "deepseek/deepseek-v4.1-flash", "gpt-5.6-sol"],
  },
  {
    providerId: "a8d7",
    providerName: "mikasaapi",
    apiKey: "k3",
    baseUrl: "https://mikasaapi.top/v1",
    models: ["gpt-5.6-terra"],
  },
];

const CFG = {
  config: {
    providerOrder: ["a8d7", "f997", "new-provider-2"],
    providerConfigRules: {
      providerRules: ROUTES.map((r) => ({
        providerId: r.providerId,
        providerName: r.providerName,
        config: {
          access: { type: "api-key", apiKey: r.apiKey },
          api: { type: "anthropic-messages", baseUrl: r.baseUrl },
          personalModelIds: r.models,
        },
      })),
    },
  },
};

test("真机 aria-label 全部能反查到正确模型", () => {
  const cases = [
    ["workbuddy代理/cn:deepseek-v4.1-flash 最高", "cn:deepseek-v4.1-flash", "workbuddy代理"],
    ["mikasaapi/gpt-5.6-terra 最高", "gpt-5.6-terra", "mikasaapi"],
    ["cmcode/deepseek/deepseek-v4.1-flash 最高", "deepseek/deepseek-v4.1-flash", "cmcode"],
    ["cmcode/meta/muse-spark-1.3-contributor 高", "meta/muse-spark-1.3-contributor", "cmcode"],
    ["workbuddy代理/cn:glm-5.3-flash 最高", "cn:glm-5.3-flash", "workbuddy代理"],
  ];
  for (const [label, model, provider] of cases) {
    const r = matchByLabel(ROUTES, label);
    assert.ok(r, `未能匹配: ${label}`);
    assert.equal(r.model, model, `模型不符: ${label}`);
    assert.equal(r.route.providerName, provider, `provider 不符: ${label}`);
  }
});

test("模型 id 含 / 时不会被按分隔符切错", () => {
  const r = matchByLabel(ROUTES, "cmcode/meta/muse-spark-1.3-contributor 高");
  assert.equal(r.model, "meta/muse-spark-1.3-contributor");
  assert.equal(r.route.providerName, "cmcode");
});

test("前缀包含不会误判：取最长匹配", () => {
  const routes = [
    { providerId: "p", providerName: "P", apiKey: "k", baseUrl: "http://x/v1", models: ["gpt-6", "gpt-6-astra"] },
  ];
  const r = matchByLabel(routes, "P/gpt-6-astra 最高");
  assert.equal(r.model, "gpt-6-astra", "应命中完整 id 而不是短前缀");
});

test("模型 id 是更长标识符的一部分时不算命中", () => {
  const routes = [
    { providerId: "p", providerName: "P", apiKey: "k", baseUrl: "http://x/v1", models: ["gpt-6"] },
  ];
  assert.equal(matchByLabel(routes, "P/gpt-6-astra 最高"), null, "gpt-6 不应命中 gpt-6-astra 的内部");
  assert.equal(matchByLabel(routes, "P/gpt-60 最高"), null);
});

test("中文尾缀（最高/高/中/低）不影响匹配", () => {
  const base = "workbuddy代理/cn:deepseek-v4.1-flash";
  for (const suffix of [" 最高", " 高", " 中", " 低", ""]) {
    const r = matchByLabel(ROUTES, base + suffix);
    assert.ok(r, `尾缀 ${JSON.stringify(suffix)} 导致匹配失败`);
    assert.equal(r.model, "cn:deepseek-v4.1-flash");
  }
});

test("等长歧义 → 返回 null（宁可回落也不猜）", () => {
  const routes = [
    { providerId: "p1", providerName: "P1", apiKey: "k", baseUrl: "http://a/v1", models: ["model-x"] },
    { providerId: "p2", providerName: "P2", apiKey: "k", baseUrl: "http://b/v1", models: ["model-x"] },
  ];
  assert.equal(matchByLabel(routes, "P1/model-x 最高"), null);
});

test("空标签 / 非字符串 / 无关文本 → null", () => {
  assert.equal(matchByLabel(ROUTES, ""), null);
  assert.equal(matchByLabel(ROUTES, "   "), null);
  assert.equal(matchByLabel(ROUTES, null), null);
  assert.equal(matchByLabel(ROUTES, undefined), null);
  assert.equal(matchByLabel(ROUTES, 123), null);
  assert.equal(matchByLabel(ROUTES, "一些完全无关的文案"), null);
});

test("resolveRoute 优先跟随会话模型", () => {
  const r = resolveRoute(CFG, { sessionModelLabel: "mikasaapi/gpt-5.6-terra 最高" });
  assert.equal(r.source, "follow-session");
  assert.equal(r.model, "gpt-5.6-terra");
  assert.equal(r.providerName, "mikasaapi");
  assert.equal(r.baseUrl, "https://mikasaapi.top/v1");
});

test("resolveRoute：跟随失败时回落到 config 显式指定", () => {
  const r = resolveRoute(CFG, {
    sessionModelLabel: "无法识别的标签",
    provider: "new-provider-2",
    model: "cn:deepseek-v4.1-flash",
  });
  assert.equal(r.source, "explicit-provider");
  assert.equal(r.model, "cn:deepseek-v4.1-flash");
});

test("resolveRoute：跟随失败且无显式配置 → 回落默认", () => {
  const r = resolveRoute(CFG, { sessionModelLabel: "unmatchable" });
  assert.equal(r.source, "default");
  assert.equal(r.providerName, "mikasaapi", "providerOrder 第一条");
  assert.equal(r.model, "gpt-5.6-terra");
});

test("resolveRoute：跟踪结果带齐 apiKey 与 baseUrl（能直接发请求）", () => {
  const r = resolveRoute(CFG, { sessionModelLabel: "cmcode/gpt-5.6-sol 最高" });
  assert.equal(r.source, "follow-session");
  assert.equal(r.apiKey, "k2");
  assert.equal(r.baseUrl, "http://127.0.0.1:9090/v1");
  assert.equal(r.model, "gpt-5.6-sol");
});

test("resolveRoute：完全没有 label 时行为与 v0.1.0 一致", () => {
  const r = resolveRoute(CFG, {});
  assert.equal(r.source, "default");
  const r2 = resolveRoute(CFG, { provider: "new-provider-2", model: "cn:kimi-k3-1" });
  assert.equal(r2.source, "explicit-provider");
  assert.equal(r2.model, "cn:kimi-k3-1");
});

test("resolveRoute：label 命中但该 provider 无 apiKey → 不会被选中", () => {
  const cfg = JSON.parse(JSON.stringify(CFG));
  // 把 mikasaapi 的 apiKey 去掉，它应被 listRoutes 过滤掉
  cfg.config.providerConfigRules.providerRules[2].config.access = { type: "oauth" };
  const r = resolveRoute(cfg, { sessionModelLabel: "mikasaapi/gpt-5.6-terra 最高" });
  assert.notEqual(r.source, "follow-session", "无凭据的 provider 不能被跟随选中");
  assert.ok(r.baseUrl.startsWith("http"), "必须回落到有凭据的路由");
});
