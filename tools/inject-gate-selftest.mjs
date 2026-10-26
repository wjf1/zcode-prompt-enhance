// 用 stub 的 electron 模块把 inject-main.cjs 完整加载一遍，
// 模拟「窗口创建 → 加载完成 → 注入」的真实时序。
//
// v0.3.0 回归（本工具就是为它写的）：web-contents-created 触发时 wc.getURL()
// 是空串，若在创建时就按 URL 判可信，主窗口会被当场拒绝、did-finish-load
// 永远挂不上 —— 症状是桥活着（loader 已加载）、按钮却从未出现。
// 旧行为在本工具下会 FAIL「加载完成后注入」两条；修复后全绿。
import { createRequire } from "node:module";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(HERE, "..", "inject-main.cjs");

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS", name);
  else {
    console.log("  FAIL", name, extra === undefined ? "" : JSON.stringify(extra));
    fail += 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILE_URL = "file:///E:/ZCode/resources/app.asar/out/renderer/index.html";

const state = { appHandlers: {}, wcs: [], executed: [] };

function makeWC(opts = {}) {
  const wc = {
    __url: opts.url || "",
    __loading: !!opts.loading,
    __listeners: {},
    __type: opts.type || "window",
    isDestroyed: () => false,
    getType() {
      return this.__type;
    },
    getURL() {
      return this.__url;
    },
    isLoading() {
      return this.__loading;
    },
    on(ev, fn) {
      (this.__listeners[ev] = this.__listeners[ev] || []).push(fn);
    },
    executeJavaScript(src) {
      state.executed.push({ wc: this, src });
      return Promise.resolve();
    },
    finishLoad(url) {
      if (url !== undefined) this.__url = url;
      this.__loading = false;
      for (const fn of this.__listeners["did-finish-load"] || []) fn();
    },
  };
  return wc;
}

/* 场景 A：loader 加载时窗口已存在（初始遍历路径） */
const preLoading = makeWC({ loading: true }); // 加载中、尚无 URL —— v0.3.0 在这里把它丢掉
const preLoaded = makeWC({ url: FILE_URL, loading: false }); // 已加载完 —— 新旧代码都应立即注入
state.wcs.push(preLoading, preLoaded);

const fakeElectron = {
  app: { on: (ev, fn) => { state.appHandlers[ev] = fn; } },
  webContents: { getAllWebContents: () => state.wcs },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return fakeElectron;
  return origLoad.apply(this, arguments);
};
try {
  const require = createRequire(import.meta.url);
  require(LOADER); // 同步执行 loader 顶层：readCfg → startBridge → 注册 → 遍历已有窗口
} finally {
  Module._load = origLoad;
}

await sleep(600); // 等 listen(0) 回调写入 bridgePort（inject 未就绪时会以 300ms 自重试）

console.log("[1] 初始遍历：loader 加载时已存在的窗口");
check(
  "已加载完成的 file: 窗口立即注入",
  (() => {
    const e = state.executed.find((x) => x.wc === preLoaded);
    return !!e && e.src.includes("__ZPE_BOOT__");
  })()
);
check("加载中（空 URL）窗口不立即注入", !state.executed.some((x) => x.wc === preLoading));
preLoading.finishLoad(FILE_URL);
await sleep(50);
check(
  "初始遍历注册的 did-finish-load 生效（v0.3.0 回归锚点一）",
  state.executed.some((x) => x.wc === preLoading)
);

console.log("\n[2] web-contents-created：创建时 URL 为空的主窗口");
const creationHandler = state.appHandlers["web-contents-created"];
check("注册了 web-contents-created 处理器", typeof creationHandler === "function");

const win = makeWC({ loading: true });
creationHandler(null, win);
check("创建时（空 URL）不注入", !state.executed.some((x) => x.wc === win));
win.finishLoad(FILE_URL);
await sleep(50);
const inj = state.executed.find((x) => x.wc === win);
check("加载完成后注入（v0.3.0 回归锚点二）", !!inj);
check("注入源含 __ZPE_BOOT__ 负载", !!inj && inj.src.includes("__ZPE_BOOT__"));
check("注入源含浮层源码（>20KB）", !!inj && inj.src.length > 20000, inj && inj.src.length);

console.log("\n[3] 不可信目标仍被拒（安全门禁不放松）");
const remote = makeWC({ loading: true });
creationHandler(null, remote);
remote.finishLoad("https://evil.example.com/");
await sleep(50);
check("远程页面不注入", !state.executed.some((x) => x.wc === remote));

const wv = makeWC({ type: "webview", loading: true });
creationHandler(null, wv);
wv.finishLoad(FILE_URL);
await sleep(50);
check("webview 类型不注入", !state.executed.some((x) => x.wc === wv));

console.log("\n" + (fail === 0 ? "ALL PASS" : fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
