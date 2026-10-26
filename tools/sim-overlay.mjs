// 在最小模拟 DOM 里跑浮层的完整交互链路。
//
// 目的：在重启客户端之前，把「挂载 → 置灰 → 点击 → 写入 → 撤销 → diff」整条路径走一遍，
// 抓出只在运行时才暴露的 JS 错误（例如变量提前使用、事件回调里引用未定义）。
// 这是真实点击走查的补充，不能替代它。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const OVERLAY = path.join(process.cwd(), "overlay-prompt-enhance.js");
const SRC = fs.readFileSync(OVERLAY, "utf8");

/* ---------- 最小 DOM 模拟 ---------- */
/** CSS 属性名 → DOM style 驼峰名（够覆盖 overlay 用到的那些）。 */
function camel(prop) {
  return String(prop).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = new Proxy(
      {
        /** 真实 DOM 里 cssText 会展开成各属性；不展开的话 style.display 永远是空串，
            任何 `style.display !== "none"` 的判断都会把"隐藏"当成"可见"（假绿）。 */
        set cssText(v) {
          this._css = String(v);
          for (const decl of String(v).split(";")) {
            const idx = decl.indexOf(":");
            if (idx < 0) continue;
            const k = decl.slice(0, idx).trim();
            const val = decl.slice(idx + 1).trim();
            if (k) this[camel(k)] = val;
          }
        },
        get cssText() {
          return this._css || "";
        },
        setProperty(k, v) {
          this[k] = v;
        },
        removeProperty(k) {
          delete this[k];
        },
      },
      {
        get: (t, k) => (k in t ? t[k] : ""),
        set: (t, k, v) => {
          t[k] = v;
          return true;
        },
      }
    );
    this.attrs = {};
    this.textContent = "";
    this.className = "";
    this._listeners = {};
    this.id = "";
  }
  /* 真实 DOM 里新建元素 isConnected === false，挂上树后才 true。
     模拟必须一致，否则 mount() 里的 `if (!wrap.isConnected)` 会被跳过、浮层永不挂载。 */
  get isConnected() {
    return this._root === true || !!this.parentNode;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "id") this.id = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  appendChild(n) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  addEventListener(t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn);
  }
  dispatch(t, ev = {}) {
    for (const fn of this._listeners[t] || []) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
  }
  querySelectorAll() {
    return [];
  }
  /* positionDiff() 会按 #zpe-diff-body 取正文区。缺这个方法会让定位链路每帧抛错，
     而错误只落进 state.placeError，模拟链路看起来"绿"其实 diff 卡从未被定位过。 */
  querySelector(sel) {
    const want = String(sel).startsWith("#") ? String(sel).slice(1) : "";
    if (want) {
      const walk = (n) => {
        if (n.id === want) return n;
        for (const c of n.children) {
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(this);
    }
    const tag = String(sel).toUpperCase();
    const walkTag = (n) => {
      if (n.tagName === tag) return n;
      for (const c of n.children) {
        const r = walkTag(c);
        if (r) return r;
      }
      return null;
    };
    return walkTag(this);
  }
  closest() {
    return null;
  }
  contains(n) {
    let p = n;
    while (p) {
      if (p === this) return true;
      p = p.parentNode;
    }
    return false;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  get offsetWidth() {
    return 28;
  }
  get offsetHeight() {
    return 28;
  }
  focus() {}
}

/* ---------- 假的 Lexical 编辑器 ---------- */
function makeLexical(initial = "") {
  let text = initial;
  const ed = {
    getEditorState() {
      return {
        toJSON() {
          return {
            root: {
              type: "root",
              children: String(text)
                .split("\n")
                .map((line) => ({
                  type: "paragraph",
                  children: line ? [{ type: "text", text: line }] : [],
                })),
            },
          };
        },
      };
    },
    parseEditorState(json) {
      const lines = (json.root.children || []).map((p) =>
        (p.children || []).map((c) => c.text || "").join("")
      );
      return { __text: lines.join("\n") };
    },
    setEditorState(state) {
      text = state.__text;
      composerEl.__text = text;
    },
  };
  return { ed, getText: () => text, setText: (t) => (text = t) };
}

/* ---------- 组装沙箱 ---------- */
let composerEl;
let cardEl;
let lexCtl;

function buildSandbox(opts = {}) {
  const body = new FakeNode("body");
  body._root = true;

  cardEl = new FakeNode("div");
  cardEl.getBoundingClientRect = () => ({ left: 333, top: 608, width: 861, height: 105, right: 1194, bottom: 713 });

  const btns = [
    { aria: "添加上下文", rect: [345, 673, 28, 28] },
    { aria: "切换模式", rect: [377, 673, 111, 28] },
    { aria: "workbuddy代理/cn:deepseek-v4.1-flash 最高", rect: [932, 673, 218, 28] },
  ];
  cardEl.querySelectorAll = (sel) => {
    // 计数：用于断言"卡片矩形没变时不重复扫描工具行"（T08 每帧开销收敛）
    cardEl.__qsCalls = (cardEl.__qsCalls || 0) + 1;
    if (sel !== "button" && sel !== "button, [role='button']") return [];
    return btns.map((b) => {
      const n = new FakeNode("button");
      n.getBoundingClientRect = () => ({
        left: b.rect[0],
        top: b.rect[1],
        width: b.rect[2],
        height: b.rect[3],
        right: b.rect[0] + b.rect[2],
        bottom: b.rect[1] + b.rect[3],
      });
      n.getAttribute = (k) => (k === "aria-label" ? b.aria : null);
      return n;
    });
  };
  cardEl.__qsCalls = 0;

  composerEl = new FakeNode("div");
  composerEl.setAttribute("contenteditable", "true");
  composerEl.getBoundingClientRect = () => ({ left: 345, top: 621, width: 836, height: 40, right: 1181, bottom: 661 });
  Object.defineProperty(composerEl, "innerText", {
    get: () => lexCtl.getText(),
    configurable: true,
  });

  lexCtl = makeLexical("");
  composerEl.__lexicalEditor_probe = lexCtl.ed;

  composerEl.parentElement = cardEl;
  cardEl.parentElement = body;

  const document = {
    body,
    documentElement: new FakeNode("html"),
    createElement: (t) => new FakeNode(t),
    createRange: () => ({ selectNodeContents() {}, deleteContents() {} }),
    querySelectorAll: (sel) => {
      if (sel.includes("contenteditable")) return [composerEl];
      return [];
    },
    querySelector: () => null,
    elementFromPoint: () => composerEl,
    addEventListener(t, fn) {
      (this._l || (this._l = {}))[t] = (this._l[t] || []).concat(fn);
    },
    _l: {},
  };

  const window = {
    innerWidth: 1280,
    innerHeight: 760,
    document,
    getSelection: () => ({ removeAllRanges() {}, addRange() {}, deleteFromDocument() {} }),
    // colorScheme / matchMedia 供 isDark() 的兜底分支使用
    getComputedStyle: () => ({
      backgroundColor: opts.transparentBody ? "rgba(0, 0, 0, 0)" : "rgb(20,20,22)",
      borderTopWidth: "1px",
      pointerEvents: "auto",
      colorScheme: opts.colorScheme || "normal",
    }),
    matchMedia: (q) => ({ matches: !!(opts.prefersLight && /light/.test(q)) }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    executeJavaScript: () => Promise.resolve(),
  };
  window.window = window;

  const sandbox = {
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    // 用真实 setInterval，让 overlay 的 300ms 草稿轮询真正跑起来
    setInterval,
    clearInterval,
    // rAF 必须真正执行回调：overlay 的定位循环靠它自调度。
    // rafDead=true 模拟「Chromium 在窗口隐藏时暂停 rAF」的真实故障。
    requestAnimationFrame: opts.rafDead ? () => 1 : (fn) => setTimeout(() => fn(Date.now()), 16),
    cancelAnimationFrame: opts.rafDead ? () => {} : (id) => clearTimeout(id),
    fetch: async () => ({
      ok: true,
      status: 200,
      body: null,
      text: async () => JSON.stringify({ type: "done", text: "增强后的文本内容" }) + "\n",
    }),
    TextDecoder,
    Uint16Array,
    AbortController,
    KeyboardEvent: class {},
    InputEvent: class {},
    getSelection: window.getSelection,
    location: { href: "file:///fake" },
  };
  sandbox.globalThis = sandbox;
  sandbox.window.__ZPE_BOOT__ = { port: 12345, token: "testtoken", maxInputChars: 12000, version: "0.1.0" };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx);
  return { ctx, sandbox, window, document, body };
}

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS", name);
  else {
    console.log("  FAIL", name, extra === undefined ? "" : JSON.stringify(extra));
    fail += 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 跑 ---------- */
console.log("[1] 挂载");
const env = buildSandbox();
const st1 = env.window.__zpeState();
check("暴露 __zpeState", !!st1, st1);
if (!st1) {
  console.log("\n1 FAILED (无法继续)");
  process.exit(1);
}
check("初始 phase = idle", st1.phase === "idle", st1.phase);
check("初始无撤销栈", st1.stackDepth === 0);
check("初始无 diff", st1.hasDiff === false);
check("version 来自 boot", st1.version === "0.1.0", st1.version);
check("浮层已挂到 body", env.body.children.length >= 3, env.body.children.length);

function byIdIn(root, id) {
  const walk = (n) => {
    if (n.id === id) return n;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(root);
}
const byId = (id) => byIdIn(env.body, id);
const btn = byId("zpe-btn");
const undoBtn = byId("zpe-undo");
const diffBtn = byId("zpe-diffbtn");
const diffCard = byId("zpe-diff");
check("zpe-btn 存在", !!btn);
check("zpe-undo 存在", !!undoBtn);
check("zpe-diffbtn 存在", !!diffBtn);
check("zpe-diff 存在", !!diffCard);

console.log("\n[2] 空草稿置灰（用 aria-disabled 而非 disabled）");
check("aria-disabled = true", btn.getAttribute("aria-disabled") === "true", btn.getAttribute("aria-disabled"));
check("没有 disabled 属性", !btn.attrs.disabled, btn.attrs.disabled);
check("title 提示要输入", /请先输入/.test(btn.title), btn.title);
check("撤销按钮隐藏", undoBtn.style.display === "none", undoBtn.style.display);

console.log("\n[3] 点击空草稿不触发请求");
{
  let called = false;
  const origFetch = env.sandbox.fetch;
  env.sandbox.fetch = async (...a) => {
    called = true;
    return origFetch(...a);
  };
  btn.dispatch("click");
  await sleep(30);
  check("未发请求", !called);
  env.sandbox.fetch = origFetch;
}

console.log("\n[4] 有草稿时按钮可用");
lexCtl.setText("帮我把这个函数改快一点");
await sleep(400); // 等 overlay 的 300ms 轮询感知到草稿变化
check("phase 仍 idle", env.window.__zpeState().phase === "idle");
check("草稿已就位", lexCtl.getText() === "帮我把这个函数改快一点", lexCtl.getText());
check("按钮此时应可用（非 aria-disabled）", btn.getAttribute("aria-disabled") === "false", {
  aria: btn.getAttribute("aria-disabled"),
  title: btn.title,
  state: env.window.__zpeState(),
});

console.log("\n[5] 点击增强 → 写入草稿 → 出 diff");
{
  btn.dispatch("click");
  await sleep(200);
  const st = env.window.__zpeState();
  check("草稿被替换为增强结果", lexCtl.getText() === "增强后的文本内容", lexCtl.getText());
  check("撤销栈深度 = 1", st.stackDepth === 1, st.stackDepth);
  check("有 diff", st.hasDiff === true);
  check("diff 卡可见", st.diffVisible === true);
  check("撤销按钮显现", undoBtn.style.display !== "none", undoBtn.style.display);
  check("diff 卡内有新增图例", /新增/.test(JSON.stringify(diffCard.children.map((c) => c.textContent))) || diffCard.children.length > 0);
}

console.log("\n[6] 撤销回原文");
{
  undoBtn.dispatch("click");
  await sleep(80);
  check("草稿恢复原文", lexCtl.getText() === "帮我把这个函数改快一点", lexCtl.getText());
  check("栈清空", env.window.__zpeState().stackDepth === 0, env.window.__zpeState().stackDepth);
  check("diff 关闭", env.window.__zpeState().hasDiff === false);
}

console.log("\n[7] 卸载（热更新路径）");
{
  env.window.__zpeTeardown();
  check("__ZPE_ACTIVE__ 复位", env.window.__ZPE_ACTIVE__ === false, env.window.__ZPE_ACTIVE__);
  check("浮层从 DOM 移除", env.body.children.filter((c) => c.id && c.id.startsWith("zpe-")).length === 0);
}

console.log("\n[8] 增强失败路径（内部错误 → 按钮变红可重试）");
{
  const env2 = buildSandbox();
  lexCtl.setText("测试失败路径");
  env2.sandbox.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await sleep(20);
  const b2 = (() => {
    const walk = (n) => {
      if (n.id === "zpe-btn") return n;
      for (const c of n.children) {
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return walk(env2.body);
  })();
  b2.dispatch("click");
  await sleep(200);
  const st = env2.window.__zpeState();
  check("phase = error", st.phase === "error", st.phase);
  check("错误码为 internal", st.errorCode === "internal", st.errorCode);
  check("按钮变红", /e5484d/.test(b2.style.color), b2.style.color);
  check("title 有中文原因", /增强失败/.test(b2.title), b2.title);
  check("草稿未被改动", lexCtl.getText() === "测试失败路径", lexCtl.getText());
}

console.log("\n[9] rAF 停摆时靠 setInterval 兜底维持定位（真实故障回归）");
{
  // 复现真实故障：Chromium 在窗口隐藏时暂停 rAF。
  // 初版实现只用 rAF 自调度，此处会让按钮永久停在原地/完全不挂载。
  const env3 = buildSandbox({ rafDead: true });
  await sleep(700); // 超过 400ms 兜底周期
  const st = env3.window.__zpeState();
  check("rAF 完全不触发时仍能找到 composer", st && st.draftLen >= 0, st && st.draftLen);
  check("rAF 停摆时按钮仍被定位（display 非 none）", (() => {
    const walk = (n) => {
      if (n.id === "zpe-btn-wrap") return n;
      for (const c of n.children) {
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    const w = walk(env3.body);
    return !!w && w.style.display !== "none" && /px$/.test(w.style.left || "");
  })());

  // 模拟窗口回到前台：rAF 恢复 + visibilitychange
  env3.sandbox.__reviveRaf && env3.sandbox.__reviveRaf();
  env3.document.visibilityState = "visible";
  (env3.document._l.visibilitychange || []).forEach((fn) => fn());
  await sleep(200);
  const st2 = env3.window.__zpeState();
  check("恢复可见后状态正常", st2 && st2.draftLen >= 0, st2 && st2.draftLen);
}

console.log("\n[10] 每帧开销收敛：卡片矩形不变时不重复扫描工具行（T08）");
{
  const env5 = buildSandbox();
  const card5 = cardEl; // buildSandbox 会重置全局 cardEl 到新沙箱的卡片
  await sleep(150); // 让首帧完成定位并写入矩形签名
  check("浮层已挂载", env5.body.children.length >= 3);
  check("首帧确实扫过一次工具行", card5.__qsCalls > 0, card5.__qsCalls);

  const before = card5.__qsCalls;
  let frames = 0;
  const tick = () => {
    frames += 1;
    if (frames < 40) setTimeout(tick, 10);
  };
  tick();
  // 这段时间内 rAF 会跑很多帧（每 16ms 一帧），但卡片矩形没变
  await sleep(420);
  const delta = card5.__qsCalls - before;
  check("卡片矩形不变时不再逐帧扫描工具行", delta <= 4, { delta, frames });
  console.log("    （期间约 " + frames + " 次计时，工具行扫描 " + delta + " 次；400ms 兜底强制重算会占 1-2 次）");

  const w = (() => {
    const walk = (n) => {
      if (n.id === "zpe-btn-wrap") return n;
      for (const ch of n.children) {
        const r = walk(ch);
        if (r) return r;
      }
      return null;
    };
    return walk(env5.body);
  })();
  check("缓存期间浮层仍在正确位置", !!w && w.style.display !== "none" && /px$/.test(w.style.left || ""), {
    display: w && w.style.display,
    left: w && w.style.left,
  });
  env5.window.__zpeTeardown();
}

console.log("\n[11] 体验与无障碍修复包（T11）");
{
  // 11.1 浅色主题：body/html 背景透明 + 系统偏好浅色 → 必须判定为浅色
  const envL = buildSandbox({ transparentBody: true, prefersLight: true });
  await sleep(60);
  const toastL = (() => {
    const walk = (n) => {
      if (n.id === "zpe-toast") return n;
      for (const ch of n.children) {
        const r = walk(ch);
        if (r) return r;
      }
      return null;
    };
    return walk(envL.body);
  })();
  // 11.3 toast 跟随主题（用 --zpe-bg 变量而不是硬编码暗色）
  check("浅色主题下 toast 背景被设为浅色变量", /#ffffff/i.test(String(toastL && toastL.style["--zpe-bg"])), {
    bg: toastL && toastL.style["--zpe-bg"],
  });
  check("toast 背景不再是硬编码暗色 rgba(30,30,32)", !/rgba\(30,30,32/.test(String(toastL && toastL.style.background)), {
    background: toastL && toastL.style.background,
  });

  // 11.8 diffBtn 维护 aria-expanded（用干净沙箱，避免受前面用例的状态污染）
  const envD = buildSandbox();
  const diffBtnFresh = byIdIn(envD.body, "zpe-diffbtn");
  check("diffBtn 初始 aria-expanded = false", diffBtnFresh.getAttribute("aria-expanded") === "false", diffBtnFresh.getAttribute("aria-expanded"));

  lexCtl.setText("无障碍断言用草稿");
  await sleep(400);
  const bD = byIdIn(envD.body, "zpe-btn");
  const diffBtnD = byIdIn(envD.body, "zpe-diffbtn");
  const undoBtnD = byIdIn(envD.body, "zpe-undo");
  bD.dispatch("click");
  await sleep(250);
  check("打开 diff 后 aria-expanded = true", diffBtnD.getAttribute("aria-expanded") === "true", diffBtnD.getAttribute("aria-expanded"));
  check("首次增强后撤销栈只有 1 步（文案不提步数）", undoBtnD.title === "恢复原文", undoBtnD.title);

  // 再跑一次增强，栈深度变 2 → 文案应带"还可 2 步"
  const fetchOrig = envD.sandbox.fetch;
  envD.sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    body: null,
    text: async () => JSON.stringify({ type: "done", text: "第二版增强结果内容" }) + "\n",
  });
  bD.dispatch("click");
  await sleep(250);
  check("栈深度 2 时撤销提示带剩余步数", /还可\s*2\s*步/.test(undoBtnD.title), undoBtnD.title);
  envD.sandbox.fetch = fetchOrig;

  // 11.5 Esc 拦截：焦点不在卡片内时不得 stopPropagation
  let stopped = false;
  const handlers = envD.document._l.keydown || [];
  for (const fn of handlers) {
    fn({ key: "Escape", stopPropagation: () => (stopped = true) });
  }
  check("焦点不在 diff 卡内时 Esc 不被吞（未调用 stopPropagation）", stopped === false, { stopped });
  envD.window.__zpeTeardown();
  envL.window.__zpeTeardown();
}

console.log("\n" + (fail === 0 ? "ALL PASS" : fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
