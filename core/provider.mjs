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

/**
 * 候选配置文件路径，按优先级排列。
 *
 * 历史上已经发生过一次 v1 → v2 迁移（CLI 侧用的是 ~/.zcode/cli/config.json），
 * 所以下一次目录改版几乎必然再来一次。把候选集中在这里，路径迁移就只是改一行。
 */
export function candidateConfigPaths() {
  const home = os.homedir();
  return [
    path.join(home, ".zcode", "v2", "provider_config.json"),
    path.join(home, ".zcode", "v3", "provider_config.json"),
    path.join(home, ".zcode", "cli", "provider_config.json"),
    path.join(home, ".zcode", "v1", "provider_config.json"),
  ];
}

/**
 * 判断配置的形状，用于把"文件不存在 / 路径迁移 / 格式变了"三种失败区分开。
 *
 * @returns {"anthropic-v2" | "unknown" | "missing"}
 */
export function detectConfigShape(parsed) {
  if (!parsed || typeof parsed !== "object") return "missing";
  const rules = parsed?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return "unknown";
  if (rules.length === 0) return "unknown";
  const first = rules[0];
  const okShape =
    first &&
    typeof first === "object" &&
    !!first.config &&
    typeof first.config === "object" &&
    !!first.config.api &&
    typeof first.config.api === "object" &&
    typeof first.config.api.type === "string";
  return okShape ? "anthropic-v2" : "unknown";
}

/**
 * 遍历候选路径，返回第一个能读到的文件及其形状。
 * 解析失败的文件也要返回（shape 为 unknown），否则"格式变了"会被误报成"文件不存在"。
 *
 * @returns {{path: string|null, parsed: object|null, shape: string}}
 */
export function findConfig() {
  for (const p of candidateConfigPaths()) {
    let raw;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { path: p, parsed: null, shape: "unknown" };
    }
    return { path: p, parsed, shape: detectConfigShape(parsed) };
  }
  return { path: null, parsed: null, shape: "missing" };
}

/** 读取并解析 provider_config.json；任何异常都返回 null（不抛）。 */
export function loadProviderConfig(file) {
  try {
    if (file) {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      const rules = parsed?.config?.providerConfigRules?.providerRules;
      if (!Array.isArray(rules)) return null;
      return parsed;
    }
    // 未指定路径：走候选探测（兼容 v2 / v3 / cli / v1 的路径迁移）
    const found = findConfig();
    if (!found.parsed) return null;
    const rules = found.parsed?.config?.providerConfigRules?.providerRules;
    if (!Array.isArray(rules)) return null;
    return found.parsed;
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
 *   1) 调用方实时上报的会话模型（`sessionModelLabel`，来自工具行模型按钮的 aria-label）
 *      —— 命中即跟随会话；未命中/歧义则继续往下回落，绝不因此失败
 *   2) 显式指定的 provider + model（两者都必须合法且存在于配置中）
 *   3) 第一条可用 provider 的首个 model
 *   4) 失败 → null
 *
 * @param {object} cfg provider_config.json 内容
 * @param {{provider?: string, model?: string, sessionModelLabel?: string}} [pref]
 * @returns {{providerId:string, providerName:string, apiKey:string, baseUrl:string, model:string, source:string}|null}
 */
export function resolveRoute(cfg, pref = {}) {
  const routes = listRoutes(cfg);
  if (routes.length === 0) return null;

  const wantProvider = pref && pref.provider;
  const wantModel = pref && pref.model;

  // 1) 实时跟随会话模型
  const followed = matchByLabel(routes, pref && pref.sessionModelLabel);
  if (followed) {
    return { ...followed.route, model: followed.model, source: "follow-session" };
  }

  // 2) 显式 provider 命中（model 可以是该 provider 下任意合法 id，不要求在白名单里：
  //    用户可能用配置里没列出的模型名，但仍需通过格式白名单）
  if (wantProvider && isValidModelId(wantProvider)) {
    const hit = routes.find((r) => r.providerId === wantProvider);
    if (hit) {
      const model =
        wantModel && isValidModelId(wantModel) ? wantModel : hit.models[0];
      return { ...hit, model, source: "explicit-provider" };
    }
  }

  // 3) 只给了 model：在所有 provider 里找第一个声明了该 model 的
  if (wantModel && isValidModelId(wantModel)) {
    const hit = routes.find((r) => r.models.includes(wantModel));
    if (hit) return { ...hit, model: wantModel, source: "explicit-model" };
  }

  // 4) 默认：第一条可用 provider 的首个 model
  const first = routes[0];
  const model =
    wantModel && isValidModelId(wantModel) ? wantModel : first.models[0];
  return { ...first, model, source: "default" };
}

/**
 * 从工具行的模型按钮文本（aria-label / title / textContent）反查可用路由。
 *
 * 为什么不解析模型名：模型 id 自身可能含 "/"（`meta/muse-spark-1.3`、
 * `deepseek/deepseek-v4.1-flash`），按分隔符切分必然出错。改用「已知模型 id
 * 是否被标签文本包含」，匹配源就是 provider_config.json 里的真实清单，
 * 对界面文案变化（例如尾部追加「最高」「高」等思考档位）不敏感。
 *
 * 取最长匹配：避免 `gpt-6` 抢先命中 `gpt-6-astra` 这类前缀包含。
 * 等长且模型不同 → 判为歧义，返回 null 让上层回落，不做猜测。
 *
 * @param {ReturnType<typeof listRoutes>} routes
 * @param {string} label
 * @returns {{route:object, model:string}|null}
 */
export function matchByLabel(routes, label) {
  if (typeof label !== "string" || label.trim() === "") return null;

  const hits = [];
  for (const r of routes) {
    for (const m of r.models) {
      if (!label.includes(m)) continue;
      // 边界检查：模型 id 前后不应紧邻字母/数字/下划线/连字符/点，
      // 否则是把更长标识符的一部分当成了独立模型名（如 abc-def 命中 def）
      let idx = label.indexOf(m);
      while (idx >= 0) {
        const before = idx > 0 ? label[idx - 1] : "";
        const after = label[idx + m.length] || "";
        const boundaryBefore = before === "" || !/[A-Za-z0-9_.-]/.test(before);
        const boundaryAfter = after === "" || !/[A-Za-z0-9_.-]/.test(after);
        if (boundaryBefore && boundaryAfter) {
          hits.push({ route: r, model: m, len: m.length });
          break;
        }
        idx = label.indexOf(m, idx + 1);
      }
    }
  }
  if (hits.length === 0) return null;

  hits.sort((a, b) => b.len - a.len);
  const best = hits[0];
  // 歧义判据：等长但指向不同的 (provider, model) 组合 → 无法确定用户用的是哪个，
  // 宁可回落也不猜。注意不能只比 model 字符串：不同 provider 可能声明同名模型，
  // 那种情况下凭据/baseUrl 不同，随便选一个就是错的。
  const tied = hits.filter(
    (h) =>
      h.len === best.len &&
      (h.model !== best.model || h.route.providerId !== best.route.providerId)
  );
  if (tied.length) return null;
  return { route: best.route, model: best.model };
}
