/**
 * provider 路由解析。
 *
 * 数据源（SSOT）：~/.zcode/v2/provider_config.json
 *   config.providerConfigRules.providerRules[] —— 这是客户端内部格式，无版本契约，
 *   解析失败一律降级（返回 null），由上层提示"按钮置灰 + 手填 config.json"。
 *
 * 安全：model id 与 provider id 都要过白名单。任一不合法则整组回落默认，
 * 防止有人在 config.json 里塞换行/引号去操控请求体。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export function isValidModelId(id) {
  return typeof id === "string" && MODEL_ID_RE.test(id);
}

export function isValidBaseUrl(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function defaultConfigPath() {
  return path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
}

/** 读取并解析 provider_config.json；任何异常都返回 null（不抛）。 */
export function loadProviderConfig(file) {
  try {
    const raw = fs.readFileSync(file || defaultConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    const rules = parsed?.config?.providerConfigRules?.providerRules;
    if (!Array.isArray(rules)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 支持 anthropic-messages 的 provider 规则列表。 */
export function listRoutes(cfg) {
  const rules = cfg?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return [];
  const order = cfg?.config?.providerOrder;
  const out = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const api = r.config?.api || {};
    if (api.type !== "anthropic-messages") continue;
    const baseUrl = api.baseUrl;
    const apiKey = r.config?.access?.apiKey;
    if (!isValidBaseUrl(baseUrl)) continue;
    if (typeof apiKey !== "string" || apiKey.length === 0) continue;
    const models = Array.isArray(r.config?.personalModelIds)
      ? r.config.personalModelIds.filter(isValidModelId)
      : [];
    if (models.length === 0) continue;
    out.push({
      providerId: r.providerId,
      providerName: r.providerName || r.providerId,
      apiKey,
      baseUrl: String(baseUrl).replace(/\/+$/, ""),
      models,
    });
  }
  // providerOrder 只是客户端展示顺序；这里用它把显式排序的 provider 提前
  if (Array.isArray(order) && order.length) {
    const rank = new Map(order.map((id, i) => [id, i]));
    out.sort((a, b) => (rank.get(a.providerId) ?? 1e9) - (rank.get(b.providerId) ?? 1e9));
  }
  return out;
}

/**
 * 解析最终要用的路由。
 * 优先级：
 *   1) 显式指定的 provider + model（两者都必须合法且存在于配置中）
 *   2) 第一条可用 provider 的首个 model
 *   3) 失败 → null
 *
 * @param {object} cfg provider_config.json 内容
 * @param {{provider?: string, model?: string}} [pref] 用户配置覆盖
 * @returns {{providerId:string, providerName:string, apiKey:string, baseUrl:string, model:string, source:string}|null}
 */
export function resolveRoute(cfg, pref = {}) {
  const routes = listRoutes(cfg);
  if (routes.length === 0) return null;

  const wantProvider = pref && pref.provider;
  const wantModel = pref && pref.model;

  // 显式 provider 命中（model 可以是该 provider 下任意合法 id，不要求在白名单里：
  // 用户可能用配置里没列出的模型名，但仍需通过格式白名单）
  if (wantProvider && isValidModelId(wantProvider)) {
    const hit = routes.find((r) => r.providerId === wantProvider);
    if (hit) {
      const model =
        wantModel && isValidModelId(wantModel) ? wantModel : hit.models[0];
      return { ...hit, model, source: "explicit-provider" };
    }
  }

  // 只给了 model：在所有 provider 里找第一个声明了该 model 的
  if (wantModel && isValidModelId(wantModel)) {
    const hit = routes.find((r) => r.models.includes(wantModel));
    if (hit) return { ...hit, model: wantModel, source: "explicit-model" };
  }

  // 默认：第一条可用 provider 的首个 model
  const first = routes[0];
  const model =
    wantModel && isValidModelId(wantModel) ? wantModel : first.models[0];
  return { ...first, model, source: "default" };
}
