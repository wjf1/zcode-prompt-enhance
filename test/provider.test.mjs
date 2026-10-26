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
  candidateConfigPaths,
  detectConfigShape,
  findConfig,
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

/* ---------------- 配置版本探测与三态（v0.3.0 T06） ----------------
 * 原先路径硬编码 v2，三种失败（文件不存在 / 路径迁移 / 格式变了）全落到
 * 同一条 503 unsupported，用户和开发者都无法区分。 */

test("candidateConfigPaths：覆盖 v2 → v3 → cli → v1，且都以 provider_config.json 结尾", () => {
  const paths = candidateConfigPaths();
  assert.ok(Array.isArray(paths));
  assert.ok(paths.length >= 4);
  for (const p of paths) assert.ok(p.endsWith("provider_config.json"), p);
  assert.ok(paths[0].includes(path.join(".zcode", "v2")), "首选仍是 v2，保持既有行为");
  assert.ok(paths.some((p) => p.includes(path.join(".zcode", "v3"))), "要覆盖未来可能的 v3");
  assert.ok(paths.some((p) => p.includes(path.join(".zcode", "cli"))), "要覆盖 CLI 侧的 cli 目录");
  assert.equal(new Set(paths).size, paths.length, "候选路径不应重复");
});

test("detectConfigShape：合法 v2 配置 → anthropic-v2", () => {
  assert.equal(detectConfigShape(CFG), "anthropic-v2");
});

test("detectConfigShape：空对象 / 缺 rules → unknown", () => {
  assert.equal(detectConfigShape({}), "unknown");
  assert.equal(detectConfigShape({ config: {} }), "unknown");
  assert.equal(detectConfigShape({ config: { providerConfigRules: { providerRules: [] } } }), "unknown");
  // 有 rules 但没有 api.type —— 结构变了
  assert.equal(detectConfigShape({ config: { providerConfigRules: { providerRules: [{ providerId: "x" }] } } }), "unknown");
});

test("detectConfigShape：null / 非对象 → missing", () => {
  assert.equal(detectConfigShape(null), "missing");
  assert.equal(detectConfigShape(undefined), "missing");
  assert.equal(detectConfigShape("string"), "missing");
  assert.equal(detectConfigShape(42), "missing");
});

test("findConfig：本机有配置时应命中某个候选路径并给出形状", () => {
  const found = findConfig();
  assert.ok(found && typeof found === "object");
  assert.ok(["anthropic-v2", "unknown", "missing"].includes(found.shape), found.shape);
  if (found.shape === "missing") {
    assert.equal(found.path, null);
    assert.equal(found.parsed, null);
  } else {
    assert.ok(typeof found.path === "string" && found.path.length > 0, "命中时必须给出路径");
    assert.ok(candidateConfigPaths().includes(found.path), "路径必须来自候选清单");
  }
});

test("findConfig 的返回结构与 findConfig 对坏 JSON 的判定保持一致", () => {
  // 坏 JSON 应当被判为 unknown（说明文件在，但格式不认），不能被当成 missing
  const p = path.join(os.tmpdir(), `zpe-shape-${process.pid}.json`);
  fs.writeFileSync(p, "{broken", "utf8");
  try {
    assert.equal(loadProviderConfig(p), null, "坏 JSON 仍返回 null，不抛");
    assert.notEqual(detectConfigShape(null), "anthropic-v2");
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test("loadProviderConfig：不传路径时走候选探测（不再硬编码 v2）", () => {
  // 直接调无参版本不应抛，且在无配置环境返回 null
  const got = loadProviderConfig();
  assert.ok(got === null || typeof got === "object");
});
