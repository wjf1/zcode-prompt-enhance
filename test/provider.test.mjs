import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isValidModelId,
  isValidBaseUrl,
  listRoutes,
  resolveRoute,
  loadProviderConfig,
} from "../core/provider.mjs";

const CFG = {
  schemaVersion: 1,
  config: {
    providerOrder: ["p-openai", "p-anth", "p-noKey"],
    providerConfigRules: {
      providerRules: [
        {
          providerId: "p-openai",
          providerName: "openai",
          config: {
            access: { type: "api-key", apiKey: "k1" },
            api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" },
            personalModelIds: ["gpt-x"],
          },
        },
        {
          providerId: "p-anth",
          providerName: "anthropic",
          config: {
            access: { type: "api-key", apiKey: "k2" },
            api: { type: "anthropic-messages", baseUrl: "https://anth.example.com/v1" },
            personalModelIds: ["cn:model-a", "cn:model-b"],
          },
        },
        {
          providerId: "p-noKey",
          providerName: "nokey",
          config: {
            access: { type: "oauth" },
            api: { type: "anthropic-messages", baseUrl: "https://nokey.example.com/v1" },
            personalModelIds: ["m1"],
          },
        },
      ],
    },
  },
};

test("model id 白名单", () => {
  assert.ok(isValidModelId("cn:deepseek-v4.1-flash"));
  assert.ok(isValidModelId("gpt-5.6-terra"));
  assert.ok(isValidModelId("meta/muse-spark-1.3"));
  assert.ok(!isValidModelId(""));
  assert.ok(!isValidModelId("-leading-dash"));
  assert.ok(!isValidModelId("has space"));
  assert.ok(!isValidModelId("has\nnewline"), "换行必须被拒");
  assert.ok(!isValidModelId("a".repeat(201)), "超长必须被拒");
  assert.ok(!isValidModelId(null));
  assert.ok(!isValidModelId(123));
});

test("baseUrl 只接受 http/https", () => {
  assert.ok(isValidBaseUrl("http://127.0.0.1:7863/v1"));
  assert.ok(isValidBaseUrl("https://api.example.com/v1"));
  assert.ok(!isValidBaseUrl("file:///etc/passwd"));
  assert.ok(!isValidBaseUrl("javascript:alert(1)"));
  assert.ok(!isValidBaseUrl(""));
  assert.ok(!isValidBaseUrl("not a url"));
});

test("listRoutes 只保留 anthropic-messages 且带 key 的 provider", () => {
  const routes = listRoutes(CFG);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].providerId, "p-anth");
  assert.equal(routes[0].baseUrl, "https://anth.example.com/v1");
  assert.deepEqual(routes[0].models, ["cn:model-a", "cn:model-b"]);
});

test("listRoutes 去掉 baseUrl 尾部斜杠，避免拼出 //messages", () => {
  const cfg = JSON.parse(JSON.stringify(CFG));
  cfg.config.providerConfigRules.providerRules[1].config.api.baseUrl = "https://x.example.com/v1///";
  assert.equal(listRoutes(cfg)[0].baseUrl, "https://x.example.com/v1");
});

test("resolveRoute：默认取第一条可用 provider 的首个 model", () => {
  const r = resolveRoute(CFG);
  assert.equal(r.providerId, "p-anth");
  assert.equal(r.model, "cn:model-a");
  assert.equal(r.source, "default");
});

test("resolveRoute：显式 provider + model 命中", () => {
  const r = resolveRoute(CFG, { provider: "p-anth", model: "cn:model-b" });
  assert.equal(r.model, "cn:model-b");
  assert.equal(r.source, "explicit-provider");
});

test("resolveRoute：只给 model 时按 model 反查 provider", () => {
  const r = resolveRoute(CFG, { model: "cn:model-b" });
  assert.equal(r.providerId, "p-anth");
  assert.equal(r.model, "cn:model-b");
  assert.equal(r.source, "explicit-model");
});

test("resolveRoute：非法 provider/model 整组回落默认", () => {
  const r1 = resolveRoute(CFG, { provider: "has\ninjection", model: "bad\nmodel" });
  assert.equal(r1.providerId, "p-anth");
  assert.equal(r1.source, "default");

  const r2 = resolveRoute(CFG, { provider: "p-nonexistent" });
  assert.equal(r2.source, "default");
});

test("resolveRoute：无可用配置返回 null", () => {
  assert.equal(resolveRoute({}), null);
  assert.equal(resolveRoute(null), null);
  assert.equal(resolveRoute({ config: { providerConfigRules: { providerRules: [] } } }), null);
});

test("loadProviderConfig：文件不存在返回 null 不抛", () => {
  assert.equal(loadProviderConfig(path.join(os.tmpdir(), "__definitely_missing__.json")), null);
});

test("loadProviderConfig：坏 JSON 返回 null 不抛", () => {
  const p = path.join(os.tmpdir(), `zpe-bad-${process.pid}.json`);
  fs.writeFileSync(p, "{not json", "utf8");
  try {
    assert.equal(loadProviderConfig(p), null);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test("loadProviderConfig：正常文件可解析", () => {
  const p = path.join(os.tmpdir(), `zpe-ok-${process.pid}.json`);
  fs.writeFileSync(p, JSON.stringify(CFG), "utf8");
  try {
    const cfg = loadProviderConfig(p);
    assert.ok(cfg);
    assert.equal(resolveRoute(cfg).model, "cn:model-a");
  } finally {
    fs.rmSync(p, { force: true });
  }
});
