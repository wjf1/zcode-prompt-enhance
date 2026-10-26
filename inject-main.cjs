/* zcode-prompt-enhance —— 主进程注入 loader。
 *
 * 由 repatch_asar.mjs 在 app.asar 的 out/main/index.js 尾部追加一行 import 引入。
 * 注入标记 __ZPE_PATCH__（与状态栏项目的 __ZUSAGE_PATCH__ 互不干扰）。
 *
 * 职责：
 *   1) 向每个窗口注入 overlay-prompt-enhance.js（mtime 变化热更新，免重启）；
 *   2) 起一个只监听 127.0.0.1 的本地 HTTP 桥，供页面内的浮层请求增强。
 *      —— 为什么用本地桥而不是 webContents 消息：渲染端没有 nodeIntegration，
 *         拿不到 ipcRenderer；本地桥同时天然支持流式响应（进度直接回推），
 *         而且 apiKey 只存在于主进程，页面里拿不到。
 *         桥用随机端口 + 随机 token 双重限制，只接受本机回环。
 *   3) provider 路由解析（读 ~/.zcode/v2/provider_config.json）+ 三闸门 + 超时。
 *
 * 设计约束：
 *   - 绝不修改 composer 卡片的 marginBottom（那是状态栏项目的让位边距）。
 *   - 绝不插入 React 管理的 DOM 子树（重渲染会擦掉）。
 *   - 任何失败只打日志，绝不影响客户端正常功能。
 */
"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { app, webContents } = require("electron");

const HERE = __dirname; // 本 loader 以绝对 file:// URL 被 import，__dirname 即真实目录
const CONFIG_FILE = path.join(HERE, "config.json");
const OVERLAY_FILE = path.join(HERE, "overlay-prompt-enhance.js");
const LOG = (...a) => console.error("[zpe]", ...a);

const DEFAULTS = {
  hot_reload: true,
  max_input_chars: 12000,
  timeout_ms: 60000,
  provider: "",
  model: "",
  context_enabled: false,
  context_max_messages: 8,
  context_max_chars: 4000,
  // 空数组 = 只信任本地打包协议（file:/app:/chrome-extension:/devtools:）
  allowed_window_hosts: [],
};

let cfg = { ...DEFAULTS };
let cfgMtime = 0;

function readCfg() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    if (st.mtimeMs === cfgMtime) return cfg;
    cfgMtime = st.mtimeMs;
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    cfg = { ...DEFAULTS, ...raw };
  } catch {
    // 没有 config.json 时用默认值：此时走 provider_config.json 的默认路由
  }
  return cfg;
}

/* ---------------- core 模块（ESM）延迟加载 ---------------- */
let corePromise = null;
/* 已解析的 core 模块引用：错误码的 retryable 必须查 core 的表，不能再硬编码。 */
let coreMod = null;
function loadCore() {
  if (!corePromise) {
    corePromise = (async () => {
      const [provider, enhancer, gates] = await Promise.all([
        import(pathToFileUrl(path.join(HERE, "core", "provider.mjs"))),
        import(pathToFileUrl(path.join(HERE, "core", "enhancer.mjs"))),
        import(pathToFileUrl(path.join(HERE, "core", "gates.mjs"))),
      ]);
      coreMod = { provider, enhancer, gates };
      return coreMod;
    })().catch((e) => {
      corePromise = null;
      throw e;
    });
  }
  return corePromise;
}

/**
 * 错误是否值得让用户「重试」。
 *
 * 数据源必须是 core/enhancer.mjs 的 ERROR_CODES 表：早先这里只对 auth / quota
 * 两个码做了硬编码排除，把 invalid-credential（表里 retryable=false）判成可重试
 * → 浮层给不可恢复的凭据错误显示"重试"，用户点了必然再失败、并再烧一次请求额度。
 * core 未就绪时保守返回 false（不鼓励重试）。 */
function retryableOf(code) {
  try {
    if (coreMod) return !!coreMod.enhancer.describeError(code).retryable;
  } catch {}
  return false;
}

function pathToFileUrl(p) {
  // Windows 盘符路径 → file:///F:/...
  const norm = p.replace(/\\/g, "/");
  return "file:///" + (norm.startsWith("/") ? norm.slice(1) : norm);
}

/* ---------------- provider 路由（带 mtime 缓存） ---------------- */
/* 路由缓存：按 provider_config.json 的 mtime + config.json 的 mtime + 会话模型标签 三段键。
 * 会话模型会随用户切换而变，缓存键必须带上它，否则切了模型还在用旧路由。 */
let routeCache = { key: "", route: null, source: "", detail: "" };

/** 无路由时的可读原因：把"文件不存在 / 格式不认 / 没有可用 provider"三态分开。 */
function noRouteDetail(shape, hasConfig) {
  if (!hasConfig || shape === "missing") return "未找到 provider 配置（请先在 ZCode 里配置一个模型）";
  if (shape === "unknown") return "provider 配置格式无法识别（可能是 ZCode 版本升级导致）";
  return "没有可用的 anthropic-messages provider";
}

async function currentRoute(sessionModelLabel) {
  const { provider } = await loadCore();
  // 路径与形状一起探测：v2 之外还有 v3 / cli / v1 候选（历史上已经迁移过一次）
  const found = provider.findConfig();
  const cfgPath = found.path || provider.defaultConfigPath();
  let mtime = 0;
  try {
    mtime = fs.statSync(cfgPath).mtimeMs;
  } catch {
    mtime = 0;
  }
  const c = readCfg();
  const label = typeof sessionModelLabel === "string" ? sessionModelLabel : "";
  const key = mtime + "|" + found.shape + "|" + cfgPath + "|" + cfgMtime + "|" + c.provider + "|" + c.model + "|" + label;
  if (routeCache.key === key) {
    return {
      route: routeCache.route,
      source: routeCache.source,
      reason: routeCache.detail,
      shape: found.shape,
      configPath: cfgPath,
    };
  }

  const pcfg = found.parsed;
  const route = provider.resolveRoute(pcfg, {
    provider: c.provider,
    model: c.model,
    sessionModelLabel: label,
  });
  const detail = route ? "" : noRouteDetail(found.shape, !!found.parsed);
  routeCache = { key, route, source: route ? route.source : "", detail };
  return { route, source: route ? route.source : "", reason: detail, shape: found.shape, configPath: cfgPath };
}

/* ---------------- 闸门 ---------------- */
let gatesPromise = null;
function getGates() {
  if (!gatesPromise) {
    gatesPromise = loadCore().then(({ gates }) => gates.createGates());
  }
  return gatesPromise;
}

/* ---------------- 本地 HTTP 桥 ---------------- */
const BRIDGE_TOKEN = crypto.randomBytes(16).toString("hex");
let bridgePort = 0;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limitBytes) {
        // 超限立即断：不读一个字节更多
        reject(Object.assign(new Error("payload too large"), { code: "too-long" }));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function startBridge() {
  const server = http.createServer(async (req, res) => {
    /* Host 校验必须在 token 校验之前：
     * 防 DNS rebinding —— 攻击者域名可以解析到 127.0.0.1，此时来源 IP 也是本机，
     * 但 Host 头会是攻击者的域名。只认回环主机名才能真正锁死"本机页面"。 */
    const host = String(req.headers.host || "");
    if (bridgePort && host !== "127.0.0.1:" + bridgePort && host !== "localhost:" + bridgePort) {
      return json(res, 403, { code: "forbidden" });
    }

    // 只接受本机回环 + 正确 token
    const token = req.headers["x-zpe-token"];
    if (token !== BRIDGE_TOKEN) return json(res, 403, { code: "forbidden" });

    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/health") {
      const hr = await currentRoute().catch(() => ({ route: null, shape: "missing", configPath: null }));
      return json(res, 200, {
        ok: true,
        version: "0.3.1",
        model: hr.route ? hr.route.model : null,
        provider: hr.route ? hr.route.providerName : null,
        maxInputChars: readCfg().max_input_chars,
        // 三态诊断：文件在哪、形状是什么，出问题时不用再靠猜
        configPath: hr.configPath || null,
        configShape: hr.shape || "missing",
      });
    }

    if (url.pathname !== "/enhance" || req.method !== "POST") {
      return json(res, 404, { code: "not-found" });
    }

    const c = readCfg();
    // 请求体上限：maxInputChars × 6（UTF-8 最坏情况）+ 4096 余量
    const limit = c.max_input_chars * 6 + 4096;
    let payload;
    try {
      const raw = await readBody(req, limit);
      payload = JSON.parse(raw);
    } catch (e) {
      const code = e && e.code === "too-long" ? "too-long" : "internal";
      return json(res, code === "too-long" ? 413 : 400, { code });
    }

    const draft = typeof payload?.draft === "string" ? payload.draft : "";
    // 按 code point 计长度，避免 CJK 被双倍计
    let charCount = 0;
    for (const _ of draft) charCount += 1;
    if (charCount === 0) return json(res, 400, { code: "empty" });
    if (charCount > c.max_input_chars) {
      return json(res, 413, { code: "too-long", limit: c.max_input_chars, actual: charCount });
    }

    const gates = await getGates();
    const gate = gates.check();
    if (!gate.ok) {
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      if (gate.retryAfterMs) headers["retry-after"] = String(Math.ceil(gate.retryAfterMs / 1000));
      const body = JSON.stringify({ code: gate.code === "cooldown" ? "rate-limit" : gate.code, retryAfterMs: gate.retryAfterMs });
      res.writeHead(429, { ...headers, "content-length": Buffer.byteLength(body) });
      return res.end(body);
    }

    // 会话模型标签：渲染端从工具行模型按钮读出，主进程据此实时跟随；
    // 缺失或反查失败都会安静回落到 config.json 的默认路由，不影响功能
    const sessionLabel = typeof payload?.sessionModelLabel === "string" ? payload.sessionModelLabel.slice(0, 200) : "";
    const { route, reason, source } = await currentRoute(sessionLabel);
    if (!route) return json(res, 503, { code: "unsupported", detail: reason });
    LOG("enhance route:", source, "→", route.providerName + "/" + route.model);

    const release = gates.acquire();
    const callerAbort = new AbortController();
    let callerAborted = false;
    // 客户端断开（用户点取消 / 关窗口）→ 立刻终止上游
    res.on("close", () => {
      if (!res.writableEnded) {
        callerAborted = true;
        callerAbort.abort();
      }
    });

    try {
      const { enhancer } = await loadCore();

      // 流式回推：先发头，再逐块写 NDJSON 行
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });

      const runOnce = (rt) =>
        enhancer.enhanceDraft({
          route: rt,
          draft,
          context: c.context_enabled ? payload?.context : undefined,
          signal: callerAbort.signal,
          timeoutMs: c.timeout_ms,
          onProgress: (text) => {
            if (res.writableEnded) return;
            res.write(JSON.stringify({ type: "progress", text }) + "\n");
          },
        });

      let finalRoute = route;
      let finalSource = source;
      let result;
      try {
        result = await runOnce(route);
      } catch (err) {
        /* 跟随会话模型失败时的自动回落：
         * 真机实测——会话切换到的 provider 可能额度耗尽 / 网络不可达，
         * 此时整次增强会直接失败，用户会觉得"点了没反应"。
         * 只要不是用户主动取消，就用默认路由再试一次（仅一次，避免重复烧额度）。
         *
         * timeout 例外：超时时上游可能已经产出并计费了大量 token，
         * 此时整包重发等于一次点击烧双份额度。只有"一个 token 都没吐"
         * （hadFirstChunk === false）的超时才值得回落。 */
        const code = (err && err.code) || "internal";
        const fallbackable =
          source === "follow-session" &&
          !callerAbort.signal.aborted &&
          (code === "timeout"
            ? !!err && err.hadFirstChunk === false
            : ["internal", "quota", "auth", "invalid-credential", "rate-limit", "unsupported"].includes(code));
        if (!fallbackable) throw err;

        const fb = await currentRoute(""); // 空标签 = 不跟随，走 config 默认
        if (!fb.route || fb.route.providerId + fb.route.model === route.providerId + route.model) throw err;
        LOG("follow-session failed (" + code + "), falling back to default:", fb.route.providerName + "/" + fb.route.model);
        finalRoute = fb.route;
        finalSource = "fallback-after-follow";
        result = await runOnce(fb.route);
      }

      gates.recordSuccess();
      res.write(
        JSON.stringify({
          type: "done",
          text: result.text,
          usage: result.usage || null,
          // 回传实际使用的路由，供浮层显示"用的是哪个模型"以及是否发生过回落
          model: finalRoute.model,
          providerName: finalRoute.providerName,
          routeSource: finalSource,
        }) + "\n"
      );
      res.end();
    } catch (err) {
      const code = (err && err.code) || "internal";
      if (code !== "aborted") {
        gates.recordFailure({ callerAborted });
      }
      LOG("enhance failed:", code, (err && err.detail) || (err && err.message) || "");
      if (!res.headersSent) {
        return json(res, 200, { type: "error", code, retryable: retryableOf(code) });
      }
      if (!res.writableEnded) {
        res.write(JSON.stringify({ type: "error", code, retryable: retryableOf(code) }) + "\n");
        res.end();
      }
    } finally {
      release();
    }
  });

  server.on("error", (e) => LOG("bridge server error:", e.message));
  // 端口 0 = 系统分配空闲端口，避免与其它本地工具撞车
  server.listen(0, "127.0.0.1", () => {
    bridgePort = server.address().port;
    LOG("bridge listening on 127.0.0.1:" + bridgePort);
  });
  server.unref?.();
  return server;
}

/* ---------------- overlay 注入 ---------------- */
let overlaySrc = "";
let overlayMtime = 0;
try {
  overlaySrc = fs.readFileSync(OVERLAY_FILE, "utf8");
  overlayMtime = fs.statSync(OVERLAY_FILE).mtimeMs;
} catch (e) {
  LOG("overlay missing:", e.message);
}

function bootSource() {
  const c = readCfg();
  const boot = {
    port: bridgePort,
    token: BRIDGE_TOKEN,
    maxInputChars: c.max_input_chars,
    version: "0.3.1",
  };
  return "window.__ZPE_BOOT__=" + JSON.stringify(boot) + ";\n" + overlaySrc;
}

/* ---------------- 窗口可信判定 ---------------- */
/* 加载是异步的；在它完成之前只允许本地协议（安全默认，不是"全部放行"）。 */
let trust = null;
import(pathToFileUrl(path.join(HERE, "core", "trust.mjs")))
  .then((m) => {
    trust = m.createTrustChecker(readCfg().allowed_window_hosts || []);
  })
  .catch((e) => LOG("trust module load failed:", e.message));

let trustSkipLogged = false;

function isMainWindow(wc) {
  try {
    return wc.getType() === "window";
  } catch {
    return false;
  }
}

/**
 * 是否允许向该窗口注入（含桥 token）。
 *
 * isMainWindow 只保证"是个窗口"，不保证"窗口里是我们的代码"。
 * 这里再校验窗口当前加载的 URL：远程页面默认一律拒绝，
 * 只有显式写进 config.json 的 allowed_window_hosts 才放行。
 */
function isTrustedWindow(wc) {
  try {
    if (!isMainWindow(wc)) return false;
    var url = wc.getURL();
    if (!trust) return /^(file|app|chrome-extension|devtools):/i.test(String(url || ""));
    return trust.check(url);
  } catch (e) {
    return false;
  }
}

function inject(wc) {
  if (!overlaySrc || wc.isDestroyed()) return;
  if (!isTrustedWindow(wc)) {
    // 只打第一次，避免每秒刷屏
    if (!trustSkipLogged) {
      trustSkipLogged = true;
      try {
        LOG("skip untrusted window:", wc.getURL());
      } catch {}
    }
    return;
  }
  if (!bridgePort) {
    // 端口还没分配好，稍后重试一次
    setTimeout(() => inject(wc), 300);
    return;
  }
  wc.executeJavaScript(bootSource(), true).catch(() => {});
}

function hotReload() {
  let m = 0;
  let src = "";
  try {
    m = fs.statSync(OVERLAY_FILE).mtimeMs;
    src = fs.readFileSync(OVERLAY_FILE, "utf8");
  } catch {
    return;
  }
  if (m === overlayMtime) return;
  // 先校验语法，避免把写到一半的文件注入页面
  try {
    new Function(src);
  } catch (e) {
    LOG("overlay syntax not ready, skip:", e.message);
    return;
  }
  overlayMtime = m;
  overlaySrc = src;
  LOG("overlay changed, hot-reloading");
  for (const wc of webContents.getAllWebContents()) {
    if (!isTrustedWindow(wc) || wc.isDestroyed()) continue;
    wc.executeJavaScript(
      "(function(){try{window.__zpeTeardown&&window.__zpeTeardown();}catch(e){}})()",
      true
    )
      .catch(() => {})
      .finally(() => inject(wc));
  }
}

/* ---------------- 启动 ---------------- */
readCfg();
startBridge();

/* ⚠️ web-contents-created 触发时窗口还没有 URL（getURL() 返回空串），这里只能按
 * 窗口类型过滤；可信判定（URL 校验）在 inject() 内做 —— 那时 did-finish-load
 * 已触发、URL 已就绪。v0.3.0 曾在这里直接用 isTrustedWindow，空 URL 被判不可信
 * → 主窗口的 did-finish-load 永远没挂上 → 桥活着但按钮从未注入（真机复现，
 * tools/inject-gate-selftest.mjs 的两条回归锚点即由此而来）。 */
app.on("web-contents-created", (_e, wc) => {
  if (!isMainWindow(wc)) return;
  wc.on("did-finish-load", () => inject(wc));
  if (!wc.isLoading()) inject(wc);
});

for (const wc of webContents.getAllWebContents()) {
  if (!isMainWindow(wc)) continue;
  wc.on("did-finish-load", () => inject(wc));
  if (!wc.isLoading()) inject(wc);
}

setInterval(() => {
  if (readCfg().hot_reload === false) return;
  hotReload();
}, 2000);

/* 主进程侧文件变更检测：overlay 能热更新，但 inject-main.cjs 与 core/*.mjs 不能
 * （它们已经加载进 V8，改文件不会重新执行）。这里只负责"告诉用户需要重启"，
 * 否则改了主进程代码的人会以为改动生效了，实际还在跑旧逻辑 —— 这是本轮实际踩到的坑。 */
let mainMtimeSnapshot = null;
function mainFileStamp() {
  let stamp = 0;
  const files = [
    path.join(HERE, "inject-main.cjs"),
    path.join(HERE, "core", "prompt.mjs"),
    path.join(HERE, "core", "provider.mjs"),
    path.join(HERE, "core", "enhancer.mjs"),
    path.join(HERE, "core", "diff.mjs"),
    path.join(HERE, "core", "gates.mjs"),
  ];
  for (const f of files) {
    try {
      stamp = Math.max(stamp, fs.statSync(f).mtimeMs);
    } catch {}
  }
  return stamp;
}
mainMtimeSnapshot = mainFileStamp();
setInterval(() => {
  const now = mainFileStamp();
  if (now > mainMtimeSnapshot) {
    mainMtimeSnapshot = now;
    LOG("主进程代码已变更（inject-main.cjs 或 core/*.mjs）—— 需要重启 ZCode 才能生效");
    for (const wc of webContents.getAllWebContents()) {
      if (!isTrustedWindow(wc) || wc.isDestroyed()) continue;
      wc.executeJavaScript(
        '(function(){try{window.__zpeNotifyRestartNeeded&&window.__zpeNotifyRestartNeeded();}catch(e){}})()',
        true
      ).catch(() => {});
    }
  }
}, 3000);

LOG("injected v0.3.1 (bridge host-check + trusted-window gate + anchor overlap guard + config shape probe + timeout fallback tightening)");
