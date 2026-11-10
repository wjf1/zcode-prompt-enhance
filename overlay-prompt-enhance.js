/* zcode-prompt-enhance —— 渲染端浮层。
 *
 * 由 inject-main.cjs 通过 executeJavaScript 注入（前置 window.__ZPE_BOOT__）。
 * 热更新时主进程先调 window.__zpeTeardown() 清理旧实例。
 *
 * 关键实现决定（均有实测依据）：
 *  1) 草稿写入走 Lexical 的公开 API（parseEditorState / setEditorState），
 *     不走 document 的旧式编辑命令。实测：旧式命令能写入空编辑器，
 *     但所有基于 DOM selection 的删除（delete / deleteFromDocument /
 *     range.deleteContents）全部无效 —— Lexical 的 selection 与 document selection
 *     不同步，用它写入的结果无法再被程序化清除，是单行道。
 *     setEditorState 则双向可控，且实测：内容在 1.5s 内多次 React 重渲染后仍然保持，
 *     并进入编辑器 history（Ctrl+Z 可回退），说明走的是正规更新管线。
 *  2) 写入后必须回读校验：setEditorState 后读 innerText + editor state 比对，
 *     不一致就报错，绝不静默通过（"看着变了但发的是旧的"是最危险的失败模式）。
 *  3) 浮层挂 body、position:fixed 跟随卡片矩形，绝不插入 React 管理的 DOM 子树。
 *  4) 绝不修改卡片底部的让位边距 —— 那是 token 状态栏项目在用的。 */
(function () {
  "use strict";

  if (window.__ZPE_ACTIVE__) {
    // 已有一个活实例：先拆掉它，避免双份按钮
    try {
      window.__zpeTeardown && window.__zpeTeardown();
    } catch (e) {}
  }

  var BOOT = window.__ZPE_BOOT__ || {};
  var PORT = BOOT.port || 0;
  var TOKEN = BOOT.token || "";
  var MAX_CHARS = BOOT.maxInputChars || 12000;
  var VERSION = BOOT.version || "0.3.1";

  if (!PORT || !TOKEN) {
    console.error("[zpe] missing boot payload; overlay not mounted");
    return;
  }

  window.__ZPE_ACTIVE__ = true;

  /* ---------------- 错误码文案（渲染端本地化，宿主只回 code） ---------------- */
  var ERR_TEXT = {
    auth: "鉴权失败，请检查模型配置",
    "invalid-credential": "模型凭据无效",
    "rate-limit": "请求过于频繁，请稍后重试",
    quota: "额度已用尽",
    empty: "模型返回了空内容",
    "context-window": "输入超出模型上下文上限",
    "max-tokens": "输出被截断，请缩短输入后重试",
    "tool-call": "模型返回了非预期的工具调用",
    timeout: "请求超时",
    aborted: "已取消",
    "too-long": "草稿过长，请精简后重试",
    "not-changed": "模型没有产生实质改动，请重试",
    truncated: "输出不完整（结尾被截断），请重试",
    shrunk: "增强结果比原文更简短，可能丢失信息",
    unsupported: "当前没有可用的增强模型配置",
    internal: "增强失败，请稍后重试",
    forbidden: "桥接鉴权失败",
    "draft-changed": "草稿已修改，已放弃增强结果",
    "lexical-incompatible": "编辑器版本不兼容，请更新插件",
  };
  function errText(code) {
    return ERR_TEXT[code] || ERR_TEXT.internal;
  }

  /* ---------------- 小工具 ---------------- */
  var uid = 0;
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function norm(s) {
    return String(s == null ? "" : s)
      .replace(/\u00a0/g, " ")
      .replace(/\u200b/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  function r2(n) {
    return Math.round(n);
  }
  function rectArr(r) {
    return [r2(r.left), r2(r.top), r2(r.width), r2(r.height)];
  }

  /* ---------------- composer 定位 ---------------- */
  var COMPOSER_SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';

  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function isOwn(el) {
    try {
      return !!(el && el.closest && el.closest("#zpe-btn-wrap,#zpe-diff,#zpe-toast"));
    } catch (e) {
      return false;
    }
  }

  function hitIsThroughRoot(hit) {
    return hit === document.body || hit === document.documentElement;
  }

  function findComposer() {
    var best = null;
    document.querySelectorAll(COMPOSER_SEL).forEach(function (n) {
      // 弹窗内的编辑框不是聊天输入框
      if (n.closest && n.closest('[role="dialog"]')) return;
      if (!visible(n)) return;
      var r = n.getBoundingClientRect();
      // 聊天输入框在视口下半部
      if (r.top < window.innerHeight * 0.45) return;
      try {
        var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || hitIsThroughRoot(hit)) return;
        if (!(hit === n || hit.contains(n) || n.contains(hit) || isOwn(hit))) return;
      } catch (e) {}
      if (!best || r.top > best.getBoundingClientRect().top) best = n;
    });
    return best;
  }

  function isVisualBox(n) {
    try {
      var cs = getComputedStyle(n);
      return cs.borderTopWidth !== "0px" || cs.backgroundColor !== "rgba(0, 0, 0, 0)";
    } catch (e) {
      return false;
    }
  }

  /* 容器合理性校验：候选卡片必须同时满足两个结构事实 */
  function plausibleCard(p, compRect) {
    var r;
    try {
      r = p.getBoundingClientRect();
    } catch (e) {
      return false;
    }
    // ① 宽到能包住输入框
    if (r.width < compRect.width * 0.9) return false;
    // ② 下半部真的有工具行（≥2 颗可点按钮）
    var btns;
    try {
      btns = p.querySelectorAll("button");
    } catch (e) {
      return false;
    }
    if (!btns || !btns.length) return false;
    var cnt = 0;
    for (var i = 0; i < btns.length; i++) {
      var br;
      try {
        br = btns[i].getBoundingClientRect();
      } catch (e) {
        continue;
      }
      if (br.width < 16 || br.height < 16 || br.height > 44) continue;
      if (br.top < r.top + r.height * 0.45) continue;
      cnt += 1;
    }
    return cnt >= 2;
  }

  function cardOf(n) {
    var cr = n.getBoundingClientRect();
    var p = n.parentElement;
    var last = n;
    var i = 0;
    for (; p && p !== document.body && i < 8; p = p.parentElement, i++) {
      var r = p.getBoundingClientRect();
      if (r.height > cr.height * 8 + 80) break;
      // 光"有边框或背景"不足以判定是卡片：3.16.2 起输入框内部新增了带背景的
      // 模型切换条，只按 isVisualBox 判会把那个内层容器当卡片，三处锚点全漂。
      if (isVisualBox(p) && plausibleCard(p, cr)) return p;
      last = p;
    }
    // 没有候选满足时保持原兜底：绝不返回 null，否则 place() 直接崩、按钮永久消失
    return last;
  }

  /* ---------------- Lexical 读写 ---------------- */
  function lexicalEditor(n) {
    try {
      for (var k in n) if (k.indexOf("__lexicalEditor") === 0) return n[k];
    } catch (e) {}
    return null;
  }

  function editorText(ed) {
    try {
      var json = ed.getEditorState().toJSON();
      var out = [];
      (function walk(node) {
        if (!node) return;
        if (typeof node.text === "string") out.push(node.text);
        if (node.children) node.children.forEach(walk);
        if (node.type === "paragraph" || node.type === "linebreak") out.push("\n");
      })(json.root);
      return norm(out.join(""));
    } catch (e) {
      return null;
    }
  }

  function readDraft(n) {
    return norm(n.innerText);
  }

  /** 把纯文本构造成 Lexical editor state。逐行映射为 paragraph。 */
  function buildState(ed, text) {
    var lines = String(text == null ? "" : text).replace(/\r\n/g, "\n").split("\n");
    var paras = lines.map(function (line) {
      return {
        children:
          line === ""
            ? []
            : [{ detail: 0, format: 0, mode: "normal", style: "", text: line, type: "text", version: 1 }],
        direction: "ltr",
        format: "",
        indent: 0,
        type: "paragraph",
        version: 1,
        textFormat: 0,
        textStyle: "",
      };
    });
    if (!paras.length) {
      paras = [
        {
          children: [],
          direction: "ltr",
          format: "",
          indent: 0,
          type: "paragraph",
          version: 1,
          textFormat: 0,
          textStyle: "",
        },
      ];
    }
    return ed.parseEditorState({
      root: { children: paras, direction: "ltr", format: "", indent: 0, type: "root", version: 1 },
    });
  }

  /**
   * 探针：用最小 editor state 试一次 parse，判断 Lexical 的 schema 是否还认得我们。
   * 写入失败时先跑它，用来区分"编辑器版本不兼容"与"业务逻辑错误"，
   * 否则用户只看到"写入草稿失败"，排障只能靠猜。
   */
  function probeLexical(ed) {
    try {
      var empty = ed.parseEditorState({
        root: { children: [], direction: "ltr", format: "", indent: 0, type: "root", version: 1 },
      });
      var json = empty && empty.toJSON ? empty.toJSON() : null;
      return !!(json && json.root);
    } catch (e) {
      return false;
    }
  }

  /**
   * 写入草稿并回读校验。
   *
   * 校验基准是 **Lexical 的 editor state**，不是 DOM 的 innerText：
   * 实测 Lexical 用 <p> 渲染每个段落，innerText 把块级元素当独立行读，
   * 于是 "A\nB" 会被读成 "A\n\nB"（每个段落之间都多一个换行）。
   * 写入本身完全正确（editor state 逐字一致），若拿 innerText 判等就会
   * 把每一次多行写入都误判成失败 —— 这是真机上暴露过的实际故障。
   *
   * 因此：
   *   - 有 editor 实例 → 以 editor state 为准（权威），innerText 仅做存在性检查；
   *   - 无 editor 实例（非 Lexical 输入框）→ 退化为 innerText 比较。
   *
   * @returns {{ok:boolean, reason?:string, wrote?:string}}
   */
  function writeDraft(n, text) {
    var ed = lexicalEditor(n);
    if (!ed || typeof ed.parseEditorState !== "function" || typeof ed.setEditorState !== "function") {
      return { ok: false, reason: "no-lexical-api" };
    }
    var want = norm(text);
    try {
      if (typeof n.focus === "function") n.focus({ preventScroll: true });
      ed.setEditorState(buildState(ed, want));
    } catch (e) {
      // 先探针：schema 不认了（编辑器大版本变更）与业务错误要区分开
      if (!probeLexical(ed)) return { ok: false, reason: "lexical-incompatible" };
      return { ok: false, reason: "set-state-failed: " + ((e && e.message) || e) };
    }
    var lex = editorText(ed);
    if (lex === want) {
      // editor state 是权威：DOM 的段落间额外换行是正常渲染差异，不视为失败
      return { ok: true, wrote: want };
    }
    var dom = readDraft(n);
    // editor state 读不到（null）时，用 DOM 兜底判断
    if (lex === null && dom !== "") {
      return { ok: true, wrote: want, degraded: "no-editor-state" };
    }
    // 写入成功但回读不一致：同样先探针，排除"编辑器不认这种 state"的可能
    if (!probeLexical(ed)) return { ok: false, reason: "lexical-incompatible" };
    return {
      ok: false,
      reason: "readback-mismatch",
      dom: dom,
      lexical: lex,
      want: want,
    };
  }

  /* ---------------- 增强强度 ---------------- */
  var INTENSITY_KEY = "zpe-intensity-v1";
  var INTENSITIES = ["standard", "deep"];

  /** 读持久化的强度档位；localStorage 不可用（隐私模式/配额满）时静默回落 standard。 */
  function readIntensity() {
    try {
      var v = localStorage.getItem(INTENSITY_KEY);
      if (INTENSITIES.indexOf(v) >= 0) return v;
    } catch (e) {}
    return "standard";
  }

  /** 写持久化强度档位。写失败不影响功能，只是下次不记住。 */
  function saveIntensity(v) {
    try {
      localStorage.setItem(INTENSITY_KEY, v);
    } catch (e) {}
  }

  function intensityLabel(v) {
    return v === "deep" ? "深度" : "标准";
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    phase: "idle", // idle | busy | error
    errorCode: "",
    errorDetail: "",
    stack: [], // [{before, after}]  撤销栈，上限 8
    pendingRef: "", // 我刚写入的内容（用于区分"用户改的"）
    diff: null, // {before, after, stats, segs}
    lastDraft: "",
    disabledReason: "",
    model: "",
    restartNeeded: false, // 主进程代码已变更，需要重启 ZCode
    anchorDegraded: false, // 定位已降级到非 cluster 路径或隐藏
    anchorWarned: false, // 降级告警是否已提示过（会话内一次）
    anchorSince: 0, // 降级开始时间戳
    lastAnchor: null, // 最近一次落点 { left, top, via }
    lastCardSig: "", // 卡片矩形签名缓存（避免每帧重算 anchorFor）
    lastCheapText: null, // innerText 廉价指纹（轮询短路）
    lastCloseBtn: null, // diff 卡关闭按钮引用（关闭后还焦到 ⇄）
    placeError: "", // 最近一次 place() 异常
    placeErrorLogged: false, // 是否已把 place 异常打到控制台（只打首次）
    /* 增强强度：standard = 精度优先，deep = 显式补齐边界条件与验收。
     * 持久化在本机 localStorage，跨会话记住用户选择。 */
    intensity: readIntensity(),
    warnings: [], // 最近一次增强的非阻断质量警告
  };
  var abortCtl = null;
  var rafId = 0;
  var alive = true;
  var usedRoute = null; // 最近一次增强实际使用的路由（含 model / providerName / source）

  /* ---------------- DOM 骨架 ---------------- */
  var wrap = el("div");
  wrap.id = "zpe-btn-wrap";
  wrap.setAttribute("data-zpe", "1");
  wrap.style.cssText = [
    "position:fixed",
    "z-index:2147483000",
    "pointer-events:auto",
    "display:none",
    "align-items:center",
    "gap:2px",
  ].join(";");

  var btn = el("button");
  btn.id = "zpe-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", "增强提示词");
  btn.title = "增强提示词";
  btn.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "width:28px",
    "height:28px",
    "padding:0",
    "border:1px solid transparent",
    "border-radius:8px",
    "background:transparent",
    "color:inherit",
    "cursor:pointer",
    "opacity:.75",
    "transition:opacity .15s,background .15s,color .15s",
    "font-size:15px",
    "line-height:1",
    "font-family:inherit",
  ].join(";");
  btn.textContent = "✨";

  var undoBtn = el("button");
  undoBtn.id = "zpe-undo";
  undoBtn.type = "button";
  undoBtn.setAttribute("aria-label", "恢复原文");
  undoBtn.title = "恢复原文";
  undoBtn.style.cssText = btn.style.cssText;
  undoBtn.textContent = "↺";
  undoBtn.style.display = "none";

  /* 强度切换：单击在「标准 / 深度」间切换，当前档位直接写在按钮上（不靠 tooltip），
   * 因为 tooltip 只有 hover 才可见，而档位是本次请求生效的关键前提。 */
  var intensityBtn = el("button");
  intensityBtn.id = "zpe-intensity";
  intensityBtn.type = "button";
  intensityBtn.style.cssText = btn.style.cssText;
  intensityBtn.style.width = "auto";
  intensityBtn.style.padding = "0 6px";
  intensityBtn.style.fontSize = "11px";
  intensityBtn.style.letterSpacing = ".02em";

  var diffBtn = el("button");
  diffBtn.id = "zpe-diffbtn";
  diffBtn.type = "button";
  diffBtn.setAttribute("aria-label", "查看差异");
  diffBtn.title = "查看差异";
  diffBtn.style.cssText = btn.style.cssText;
  diffBtn.textContent = "⇄";
  diffBtn.style.display = "none";

  wrap.appendChild(btn);
  wrap.appendChild(intensityBtn);
  wrap.appendChild(undoBtn);
  wrap.appendChild(diffBtn);

  var diffCard = el("div");
  diffCard.id = "zpe-diff";
  diffCard.setAttribute("data-zpe", "1");
  diffCard.setAttribute("role", "dialog");
  diffCard.setAttribute("aria-label", "增强差异");
  diffCard.style.cssText = [
    "position:fixed",
    "z-index:2147483001",
    "display:none",
    "flex-direction:column",
    "gap:8px",
    "max-width:min(560px,calc(100vw - 24px))",
    "overflow:hidden",
    "padding:10px 12px",
    "border-radius:12px",
    "border:1px solid rgba(128,128,128,.35)",
    "background:var(--zpe-bg,#1e1e20)",
    "color:var(--zpe-fg,#e8e8ea)",
    "box-shadow:0 8px 28px rgba(0,0,0,.28)",
    "font:13px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
    "pointer-events:auto",
  ].join(";");

  var toast = el("div");
  toast.id = "zpe-toast";
  toast.setAttribute("data-zpe", "1");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.style.cssText = [
    "position:fixed",
    "z-index:2147483002",
    "display:none",
    "max-width:min(420px,calc(100vw - 24px))",
    "padding:7px 11px",
    "border-radius:9px",
    "background:rgba(30,30,32,.96)",
    "color:#f5f5f7",
    "border:1px solid rgba(128,128,128,.35)",
    "box-shadow:0 6px 22px rgba(0,0,0,.3)",
    "font:13px/1.45 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
    "pointer-events:none",
  ].join(";");

  function mount() {
    if (!wrap.isConnected) document.body.appendChild(wrap);
    if (!diffCard.isConnected) document.body.appendChild(diffCard);
    if (!toast.isConnected) document.body.appendChild(toast);
  }

  /* ---------------- 主题适配 ---------------- */
  /**
   * 判断当前是否暗色主题。
   *
   * 关键：透明背景（rgba(0,0,0,0)）不能当成"黑色"。初版直接读 body 的
   * backgroundColor，浅色主题下 body 常是 transparent，于是被稳定误判成暗色，
   * 浅色用户全程看到暗色卡片。这里依次探测 :root → html → body，
   * 跳过 alpha=0 的候选；再兜底读 color-scheme；最后跟随系统媒体查询。
   */
  function isDark() {
    // :root 就是 documentElement；两层都要探，任一层有真实颜色就定下来
    var probes = [document.documentElement, document.body];
    for (var i = 0; i < probes.length; i++) {
      var node = probes[i];
      if (!node) continue;
      try {
        var bg = getComputedStyle(node).backgroundColor;
        var m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
        if (!m) continue;
        // alpha 为 0（含缺省但 rgb() 写法）时这一层没有实际颜色，继续往上找
        var alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (!(alpha > 0)) continue;
        var lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
        return lum < 0.5;
      } catch (e) {}
    }
    // 兜底 1：color-scheme 计算值（宿主若显式声明了 light/dark）
    try {
      var cs = getComputedStyle(document.documentElement).colorScheme || "";
      if (/dark/i.test(cs) && !/light/i.test(cs)) return true;
      if (/light/i.test(cs) && !/dark/i.test(cs)) return false;
    } catch (e) {}
    // 兜底 2：系统偏好
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return true;
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return false;
    } catch (e) {}
    return true;
  }
  function applyTheme() {
    var dark = isDark();
    var bg = dark ? "#1e1e20" : "#ffffff";
    var fg = dark ? "#e8e8ea" : "#1c1c1e";
    diffCard.style.setProperty("--zpe-bg", bg);
    diffCard.style.setProperty("--zpe-fg", fg);
    diffCard.style.borderColor = dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.15)";
    // toast 也用同一套变量，否则浅色主题下与宿主割裂
    toast.style.setProperty("--zpe-bg", bg);
    toast.style.setProperty("--zpe-fg", fg);
    toast.style.background = bg;
    toast.style.color = fg;
    toast.style.borderColor = dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.15)";
  }

  /* ---------------- toast ---------------- */
  var toastTimer = 0;
  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.style.display = "block";
    positionToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.style.display = "none";
    }, ms || 3200);
  }
  function positionToast() {
    if (toast.style.display === "none") return;
    var anchor = composerEl ? cardOf(composerEl) : null;
    var r = anchor ? anchor.getBoundingClientRect() : null;
    var tw = toast.offsetWidth;
    var left = r ? Math.max(8, Math.min(r2(r.left), window.innerWidth - tw - 8)) : 16;
    var top = r ? Math.max(8, r2(r.top) - toast.offsetHeight - 10) : 16;
    toast.style.left = left + "px";
    toast.style.top = top + "px";
  }

  /* ---------------- 按钮态 ---------------- */
  function setPhase(p, code, detail) {
    state.phase = p;
    state.errorCode = code || "";
    state.errorDetail = detail || "";
    renderButtons();
  }

  function renderButtons() {
    var busy = state.phase === "busy";
    var err = state.phase === "error";
    var draft = composerEl ? readDraftCanonical(composerEl) : "";
    var isEmpty = draft === "";
    var tooLong = false;
    var n = 0;
    for (var _ of draft) {
      n += 1;
      if (n > MAX_CHARS) {
        tooLong = true;
        break;
      }
    }

    if (busy) {
      btn.textContent = "◌";
      btn.title = "正在增强（点击取消）";
      btn.setAttribute("aria-label", "正在增强，点击取消");
      btn.style.opacity = "1";
      btn.style.color = "inherit";
      btn.style.cursor = "pointer";
      btn.setAttribute("aria-disabled", "false");
    } else if (err) {
      btn.textContent = "✨";
      var msg = errText(state.errorCode);
      btn.title = msg + (state.errorDetail ? "（" + state.errorDetail + "）" : "") + " — 点击重试";
      btn.setAttribute("aria-label", msg);
      btn.style.opacity = "1";
      btn.style.color = "#e5484d";
      btn.style.cursor = isEmpty ? "not-allowed" : "pointer";
      btn.setAttribute("aria-disabled", isEmpty ? "true" : "false");
    } else {
      btn.textContent = "✨";
      var why = "";
      if (isEmpty) why = "请先输入需要增强的提示词";
      else if (tooLong) why = "草稿过长（上限 " + MAX_CHARS + " 字）";
      else if (state.disabledReason) why = state.disabledReason;
      btn.title = why || "增强提示词";
      btn.setAttribute("aria-label", why || "增强提示词");
      btn.style.opacity = isEmpty || tooLong || state.disabledReason ? ".35" : ".75";
      btn.style.color = "inherit";
      btn.style.cursor = isEmpty ? "not-allowed" : "pointer";
      // 用 aria-disabled 而非 disabled：disabled 会被键盘/读屏跳过，
      // 恰好在最需要知道原因的用户那里不可达
      btn.setAttribute("aria-disabled", isEmpty || tooLong || !!state.disabledReason ? "true" : "false");
    }

    undoBtn.style.display = state.stack.length ? "inline-flex" : "none";
    // 撤销栈深度对用户不可见时，↺ 是个"不知道还能退几步"的盲盒按钮
    var depth = state.stack.length;
    var undoTip = depth > 1 ? "恢复原文（还可 " + depth + " 步）" : "恢复原文";
    undoBtn.title = undoTip;
    undoBtn.setAttribute("aria-label", undoTip);
    diffBtn.style.display = state.diff ? "inline-flex" : "none";

    /* 强度按钮：档位文字直接可见，避免"选了什么档"只能靠 hover 才知道。
     * 增强进行中禁用切换 —— 否则用户会以为能改变正在跑的这一轮。 */
    intensityBtn.textContent = intensityLabel(state.intensity);
    intensityBtn.title =
      state.intensity === "deep"
        ? "当前：深度（六段式结构化）— 点击切回标准"
        : "当前：标准（紧凑改写，贴近原句）— 点击切到深度";
    intensityBtn.setAttribute("aria-label", intensityBtn.title);
    intensityBtn.style.opacity = busy ? ".35" : ".75";
    intensityBtn.style.cursor = busy ? "not-allowed" : "pointer";
    intensityBtn.setAttribute("aria-disabled", busy ? "true" : "false");

    syncDiffExpanded();
  }

  /* [ZPE:DIFF:BEGIN]
  本块由 tools/build-overlay.mjs 从 core/diff.mjs 自动生成 —— 手改会被覆盖。
  单一事实来源是 core/diff.mjs：改算法请改那里，然后运行 node tools/build-overlay.mjs
  （--check 仅校验产物是否最新）。test/overlay-diff.test.mjs 继续做行为级产物校验。
  */
  const DIFF_TOKEN_CAP = 800;

  const TOKEN_RE = /\s+|[\u3400-\u9fff]|[A-Za-z0-9_]+|[^\s]/g;

  function zpeTokenize(text) {
    return String(text ?? "").match(TOKEN_RE) || [];
  }

  /**
   * 计算 diff 段序列。
   * @returns {{type:'same'|'del'|'ins', text:string}[]}
   */
  function zpeDiffSegments(before, after) {
    const a = zpeTokenize(before);
    const b = zpeTokenize(after);

    if (a.length > DIFF_TOKEN_CAP || b.length > DIFF_TOKEN_CAP) {
      const segs = [];
      if (before) segs.push({ type: "del", text: String(before) });
      if (after) segs.push({ type: "ins", text: String(after) });
      return segs;
    }

    const n = a.length;
    const m = b.length;
    const w = m + 1;
    const table = new Uint16Array((n + 1) * w);

    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * w + j] =
          a[i] === b[j]
            ? table[(i + 1) * w + j + 1] + 1
            : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }

    const segs = [];
    const push = (type, text) => {
      const last = segs[segs.length - 1];
      if (last && last.type === type) last.text += text;
      else segs.push({ type, text });
    };

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        push("same", a[i]);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
        push("del", a[i]);
        i += 1;
      } else {
        push("ins", b[j]);
        j += 1;
      }
    }
    while (i < n) {
      push("del", a[i]);
      i += 1;
    }
    while (j < m) {
      push("ins", b[j]);
      j += 1;
    }
    return segs;
  }

  /**
   * 统计：改动块数、新增字符数、删除字符数、净变化。
   * "处"按连续同类段的段数计。
   */
  function zpeDiffStats(segs) {
    let changedBlocks = 0;
    let added = 0;
    let removed = 0;
    let prevType = "same";
    for (const s of segs) {
      const len = [...s.text].length;
      if (s.type === "ins") added += len;
      else if (s.type === "del") removed += len;
      if (s.type !== "same" && prevType !== s.type) changedBlocks += 1;
      prevType = s.type;
    }
    return { changed: changedBlocks, added, removed, delta: added - removed };
  }

  /** 把 diff 段按换行重新切行，避免长提示词渲染成一整块。 */
  function zpeSegmentsToLines(segs) {
    const lines = [[]];
    for (const s of segs) {
      const parts = s.text.split("\n");
      parts.forEach((part, k) => {
        if (k > 0) lines.push([]);
        if (part !== "") lines[lines.length - 1].push({ type: s.type, text: part });
      });
    }
    return lines;
  }

  /** 统计行文案。 */
  function zpeFormatStats(stats) {
    const sign = stats.delta >= 0 ? "+" : "-";
    return `${stats.changed} 处改动 · ${stats.added} 字新增 / ${stats.removed} 字替换 · 净 ${sign}${Math.abs(stats.delta)} 字`;
  }

  /** 一次算全：段序列 + 统计 + 行切分 + 文案。overlay 的 diff 块由本文件生成（tools/build-overlay.mjs）。 */
  function computeDiff(before, after) {
    const segs = zpeDiffSegments(before, after);
    const stats = zpeDiffStats(segs);
    return { segs, stats, lines: zpeSegmentsToLines(segs), statsText: zpeFormatStats(stats) };
  }
  /* [ZPE:DIFF:END] */

  function renderDiff() {
    if (!state.diff) {
      diffCard.style.display = "none";
      return;
    }
    // 重取主题：openDiff 到 renderDiff 之间宿主可能已经切了明暗，
    // 不重取的话首帧会用旧配色，最迟 1.5s 后才被 themeTimer 纠正（肉眼可见的闪变）
    applyTheme();
    diffCard.textContent = "";
    var d = state.diff;

    var head = el("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px;justify-content:space-between";
    var title = el("div", null, "增强结果对比");
    title.style.cssText = "font-weight:600;font-size:12.5px;opacity:.9";
    var closeBtn = el("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "关闭差异对比");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText =
      "border:0;background:transparent;color:inherit;cursor:pointer;font-size:13px;opacity:.6;padding:2px 4px;border-radius:5px";
    closeBtn.addEventListener("click", function () {
      closeDiff(true);
    });
    // closeBtn 是局部变量，openDiff/closeDiff 里看不到它；存进 state 才能在关闭后还焦
    state.lastCloseBtn = closeBtn;
    head.appendChild(title);
    head.appendChild(closeBtn);

    var body = el("div");
    body.id = "zpe-diff-body";
    body.style.cssText =
      "flex:1 1 auto;min-height:0;max-height:min(46vh,320px);overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.6";

    var lines = d.lines || [];
    for (var i = 0; i < lines.length; i++) {
      var row = el("div");
      var segs = lines[i];
      if (!segs.length) {
        row.appendChild(el("span", null, " "));
      }
      for (var j = 0; j < segs.length; j++) {
        var s = segs[j];
        var sp = el("span", null, s.text);
        if (s.type === "ins") {
          // 不只靠颜色区分：加下划线 + 绿色底
          sp.style.cssText =
            "background:rgba(46,160,67,.22);border-bottom:1px solid rgba(46,160,67,.55);border-radius:2px";
        } else if (s.type === "del") {
          sp.style.cssText =
            "color:#e5484d;text-decoration:line-through;background:rgba(229,72,77,.12);border-radius:2px";
        }
        row.appendChild(sp);
      }
      body.appendChild(row);
    }

    var legend = el("div");
    legend.style.cssText = "display:flex;gap:12px;font-size:11.5px;opacity:.75;align-items:center";
    var lg1 = el("span", null, "新增");
    lg1.style.cssText =
      "background:rgba(46,160,67,.22);border-bottom:1px solid rgba(46,160,67,.55);padding:0 4px;border-radius:2px";
    var lg2 = el("span", null, "删除");
    lg2.style.cssText =
      "color:#e5484d;text-decoration:line-through;background:rgba(229,72,77,.12);padding:0 4px;border-radius:2px";
    legend.appendChild(lg1);
    legend.appendChild(lg2);

    var foot = el("div");
    foot.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px";
    var statLine = el("div", null, d.statsText || "");
    statLine.style.cssText = "font-size:11.5px;opacity:.75";
    var undoHere = el("button");
    undoHere.type = "button";
    undoHere.textContent = "恢复原文";
    undoHere.style.cssText =
      "border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;padding:3px 9px;border-radius:7px";
    undoHere.addEventListener("click", doUndo);
    foot.appendChild(statLine);
    foot.appendChild(undoHere);

    diffCard.appendChild(head);
    diffCard.appendChild(body);
    diffCard.appendChild(legend);
    diffCard.appendChild(foot);
    diffCard.style.display = "flex";
    positionDiff();
  }

  function openDiff() {
    renderDiff();
    // 键盘/读屏用户：打开后焦点进卡片，否则 Esc 拦截与 Tab 顺序都是断的
    try {
      if (state.lastCloseBtn && typeof state.lastCloseBtn.focus === "function") {
        state.lastCloseBtn.focus();
      }
    } catch (e) {}
    syncDiffExpanded();
  }
  /**
   * @param {boolean} [restoreFocus] 是否把焦点还给 ⇄。
   *   只有用户主动关闭（点 ✕ / 再点 ⇄ / 卡内按 Esc）才还焦；
   *   程序化关闭（撤销栈失效、撤销完成）不还 —— 那会把焦点从输入框抢走。
   */
  function closeDiff(restoreFocus) {
    var wasOpen = diffCard.style.display !== "none";
    diffCard.style.display = "none";
    if (wasOpen && restoreFocus) {
      try {
        if (diffBtn && typeof diffBtn.focus === "function") diffBtn.focus();
      } catch (e) {}
    }
    syncDiffExpanded();
  }
  /** diffBtn 的展开态：读屏靠它知道"下面还有一块对比内容"。 */
  function syncDiffExpanded() {
    if (!diffCard || !diffBtn) return;
    var open = diffCard.style.display !== "none";
    diffBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function positionDiff() {
    if (diffCard.style.display === "none" || !composerEl) return;
    var card = cardOf(composerEl);
    var ar = card.getBoundingClientRect();
    var MARGIN = 8;
    var GAP = 8;

    /* 先给卡片一个绝对高度上限：视口高度减去上下留白。
       没有这条约束时，头部+正文(46vh)+图例+底栏的总高可能超过视口，
       导致卡片顶出屏幕、关闭按钮被挡在窗口标题栏之后（真机截图实测）。 */
    var maxCardH = Math.max(160, window.innerHeight - MARGIN * 2);
    diffCard.style.maxHeight = maxCardH + "px";

    // 正文区按实际可用高度收缩，保证 头部/图例/底栏 始终可见
    var headH = 0;
    var footH = 0;
    try {
      if (diffCard.children[0]) headH = diffCard.children[0].offsetHeight;
      var foot = diffCard.children[diffCard.children.length - 1];
      if (foot) footH = foot.offsetHeight;
    } catch (e) {}
    var legendH = 20;
    var bodyMax = Math.max(80, maxCardH - headH - footH - legendH - 40);
    var bodyEl = diffCard.querySelector("#zpe-diff-body");
    if (bodyEl) bodyEl.style.maxHeight = bodyMax + "px";

    var h = diffCard.offsetHeight;
    var w = diffCard.offsetWidth;
    var left = Math.max(MARGIN, Math.min(r2(ar.left), window.innerWidth - w - MARGIN));

    // 优先放在卡片上方（不遮挡输入框）；放不下则放下方；都放不下就贴顶并压缩高度
    var topAbove = r2(ar.top) - h - GAP;
    var topBelow = r2(ar.bottom) + GAP;
    var top;
    if (topAbove >= MARGIN && topAbove + h <= window.innerHeight - MARGIN) {
      top = topAbove;
    } else if (topBelow + Math.min(h, window.innerHeight - MARGIN * 2) <= window.innerHeight - MARGIN) {
      top = topBelow;
    } else {
      top = MARGIN;
    }
    // 最终夹紧：无论走哪条路径，都不许越出视口
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - diffCard.offsetHeight - MARGIN));

    diffCard.style.left = left + "px";
    diffCard.style.top = top + "px";
  }

  /* ---------------- 草稿变化检测（撤销栈失效判定） ----------------
   * 基准统一走 readDraftCanonical：有 Lexical 实例时读 editor state（权威），
   * 否则读 innerText。绝不能用 innerText 与 editor state 的文本互相比对——
   * innerText 会在每个段落之间多一个换行，两者永远不相等，会导致
   * "刚写完就被判成用户已修改"从而清空撤销栈。 */
  function readDraftCanonical(n) {
    var ed = n ? lexicalEditor(n) : null;
    if (ed) {
      var t = editorText(ed);
      if (t !== null) return t;
    }
    return norm(n ? n.innerText : "");
  }

  /* 记录"当前草稿基准"，同时把廉价指纹一起对齐。
   * 两处必须同步更新，否则下一轮 300ms 轮询会把"自己刚写进去的内容"
   * 当成变化再深读一次（结果虽正确，但白白多跑一次全树遍历）。 */
  function syncDraftBaseline(text) {
    state.lastDraft = text;
    state.lastCheapText = norm(composerEl ? composerEl.innerText : "");
  }

  function checkDraftChange() {
    if (!composerEl) return;
    /* 廉价指纹短路：12000 字草稿下 readDraftCanonical → toJSON + 递归整棵树
     * 每次要 1-5ms，而 300ms 轮询在空闲时也在跑。
     * innerText 只用来判"没变"（变了也不代表真变了，继续走权威路径），
     * 绝不用于判等/写入校验 —— 段落间多换行的老坑见 readDraftCanonical 注释。
     * 已知取舍：纯格式变更（加粗/斜体）不改 innerText，但本插件只消费纯文本，无影响。 */
    var cheap = "";
    try {
      cheap = norm(composerEl.innerText);
    } catch (e) {
      cheap = "";
    }
    if (cheap === state.lastCheapText) return;
    state.lastCheapText = cheap;

    var draft = readDraftCanonical(composerEl);
    if (draft === state.lastDraft) return;
    var top = state.stack[state.stack.length - 1];
    if (top) {
      // 我刚写入的（pendingRef）不算"用户改了"；否则整栈失效
      if (draft !== top.after && draft !== state.pendingRef) {
        var hadStack = state.stack.length > 0;
        state.stack = [];
        state.diff = null;
        closeDiff();
        // 整栈被清空必须告知：否则用户只会发现 ↺ 突然消失，不知道为什么
        if (hadStack) showToast("撤销历史已清空", 2400);
      }
      if (draft === top.after) state.pendingRef = "";
    }
    /* error 态要随草稿修改复位：用户按提示改完草稿，按钮还红着是明确的可信度损伤。
     * 只复位"与草稿内容相关"的三类错误 —— 鉴权/额度那类错误改草稿也不会好。 */
    if (
      state.phase === "error" &&
      (state.errorCode === "draft-changed" || state.errorCode === "too-long" || state.errorCode === "empty")
    ) {
      setPhase("idle");
    }
    state.lastDraft = draft;
    renderButtons();
  }

  /* ---------------- 撤销 ---------------- */
  function doUndo() {
    if (!composerEl || !state.stack.length) return;
    var top = state.stack[state.stack.length - 1];
    var res = writeDraft(composerEl, top.before);
    if (!res.ok) {
      if (res.reason === "lexical-incompatible") showToast(errText("lexical-incompatible"));
      else showToast("恢复失败：" + (res.reason || "写入校验未通过"));
      return;
    }
    state.stack.pop();
    state.pendingRef = res.wrote;
    state.diff = null;
    syncDraftBaseline(readDraftCanonical(composerEl));
    // 撤销可能是从 diff 卡里的「恢复原文」触发的：那张卡即将关闭，
    // 焦点不能跟着它一起消失，还给 ⇄ 才是正确的落点。
    closeDiff(true);
    renderButtons();
    showToast("已恢复原文");
  }

  /* ---------------- 调用增强 ---------------- */
  function readContext() {
    // P1 不做上下文：留出接口，主进程侧 context_enabled 关闭时忽略
    return undefined;
  }

  function parseNdjsonLine(line, onEvent) {
    var s = String(line).trim();
    if (!s) return;
    var obj;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      return;
    }
    onEvent(obj);
  }

  async function callEnhance(draft) {
    var url = "http://127.0.0.1:" + PORT + "/enhance";
    var res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zpe-token": TOKEN },
        body: JSON.stringify({
          draft: draft,
          context: readContext(),
          intensity: state.intensity,
          // 实时跟随会话模型：把工具行模型按钮的标签交给主进程反查路由。
          // 取不到时传空串，主进程会回落到 config.json 的默认模型。
          sessionModelLabel: currentModelLabel(),
        }),
        signal: abortCtl.signal,
      });
    } catch (e) {
      if (abortCtl.signal.aborted) throw { code: "aborted" };
      throw { code: "internal", detail: String((e && e.message) || e) };
    }

    if (!res.ok) {
      if (res.status === 413) throw { code: "too-long" };
      if (res.status === 429) throw { code: "rate-limit" };
      if (res.status === 503) throw { code: "unsupported" };
      if (res.status === 403) throw { code: "forbidden" };
      throw { code: "internal", detail: "HTTP " + res.status };
    }

    // 流式 NDJSON：边收边更新按钮进度
    var reader = res.body && res.body.getReader ? res.body.getReader() : null;
    var final = null;
    var errObj = null;

    if (reader) {
      var decoder = new TextDecoder("utf-8");
      var buf = "";
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        buf += decoder.decode(step.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          var line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          parseNdjsonLine(line, function (evt) {
            if (evt.type === "progress") {
              var len = String(evt.text || "").length;
              btn.textContent = "◌";
              btn.title = "正在增强… 已接收 " + len + " 字（点击取消）";
              // title 只有鼠标 hover 才读得到；进度必须同步进 aria-label
              btn.setAttribute("aria-label", "正在增强，已接收 " + len + " 字，点击取消");
            } else if (evt.type === "done") {
              final = evt;
            } else if (evt.type === "error") {
              errObj = evt;
            }
          });
        }
      }
      if (buf.trim()) {
        parseNdjsonLine(buf, function (evt) {
          if (evt.type === "done") final = evt;
          else if (evt.type === "error") errObj = evt;
        });
      }
    } else {
      var text = await res.text();
      text.split("\n").forEach(function (line) {
        parseNdjsonLine(line, function (evt) {
          if (evt.type === "done") final = evt;
          else if (evt.type === "error") errObj = evt;
        });
      });
    }

    if (errObj) throw errObj;
    if (!final) throw { code: "empty" };
    // 记录实际使用的模型与路由来源（跟随成功 / 回落），供 tooltip 与状态查询
    usedRoute = {
      model: final.model || "",
      providerName: final.providerName || "",
      source: final.routeSource || "",
      // 主进程实际生效的档位与场景（场景可能由草稿自动判定）
      intensity: final.intensity || "",
      scene: final.scene || "",
    };
    // 非阻断质量警告：随成功结果回传，由调用方决定怎么温和提示
    state.warnings = Array.isArray(final.warnings) ? final.warnings : [];
    return final.text;
  }

  async function startEnhance() {
    if (!composerEl) return;
    if (state.phase === "busy") {
      // 再点 = 取消
      try {
        abortCtl && abortCtl.abort();
      } catch (e) {}
      return;
    }
    var draft = readDraftCanonical(composerEl);
    if (draft === "") {
      showToast("请先输入需要增强的提示词");
      return;
    }
    var count = 0;
    for (var _ of draft) count += 1;
    if (count > MAX_CHARS) {
      showToast("草稿过长（" + count + " 字，上限 " + MAX_CHARS + " 字），请先精简");
      return;
    }

    abortCtl = new AbortController();
    setPhase("busy");
    var source = draft;

    try {
      var result = await callEnhance(source);
      if (!alive) return;

      // 二次读草稿：请求期间用户改了草稿 → 放弃结果
      var now = readDraftCanonical(composerEl);
      if (norm(now) !== norm(source)) {
        setPhase("error", "draft-changed");
        showToast(errText("draft-changed"));
        return;
      }
      /* 空结果与"未实质改动"都由主进程 core/quality.mjs 统一判定并走错误码通道
       * （not-changed / truncated / shrunk）。这里只保留最后一道空值兜底：
       * 判定逻辑留在 core 一处，避免渲染端与主进程两套阈值各说各话。 */
      if (norm(result) === "") {
        setPhase("error", "empty");
        showToast(errText("empty"));
        return;
      }

      // 写入 + 回读校验
      var res = writeDraft(composerEl, result);
      if (!res.ok) {
        // lexical-incompatible 是可诊断的独立错误码，不该被压成 internal
        if (res.reason === "lexical-incompatible") {
          setPhase("error", "lexical-incompatible");
          showToast(errText("lexical-incompatible"));
          return;
        }
        setPhase("error", "internal", res.reason);
        showToast("写入草稿失败：" + (res.reason || "校验未通过"));
        return;
      }

      state.stack.push({ before: norm(source), after: norm(result) });
      if (state.stack.length > 8) state.stack = state.stack.slice(-8);
      state.pendingRef = norm(result);
      syncDraftBaseline(norm(result));

      // diff
      state.diff = computeDiff(norm(source), norm(result));

      setPhase("idle");
      renderButtons();
      if (state.diff) openDiff();
      /* 提示优先级：质量警告 > 路由说明 > 档位说明。
       * 缩水警告比"用了哪个模型"更需要用户看一眼，所以先报。 */
      if (state.warnings && state.warnings.length) {
        var w = state.warnings[0];
        showToast(errText(w.code || "shrunk"), 4200);
      } else if (usedRoute && usedRoute.model) {
        // 让用户能确认"这次增强用的到底是哪个模型"：跟随成功时就是会话模型
        var msg;
        var deep = usedRoute.intensity === "deep" ? "（深度）" : "";
        if (usedRoute.source === "follow-session") {
          msg = "已按会话模型增强" + deep + "：" + usedRoute.model;
        } else if (usedRoute.source === "fallback-after-follow") {
          // 跟随的模型不可用（额度/网络），自动换了默认模型 —— 必须告知，不能静默
          msg = "会话模型不可用，已改用" + deep + " " + usedRoute.model;
        } else {
          msg = "已用默认模型增强" + deep + "：" + usedRoute.model;
        }
        showToast(msg, usedRoute.source === "fallback-after-follow" ? 4200 : 2400);
      }
    } catch (e) {
      if (!alive) return;
      var code = (e && e.code) || "internal";
      if (code === "aborted") {
        // 取消：不提示、不改草稿
        setPhase("idle");
        return;
      }
      setPhase("error", code, (e && e.detail) || "");
      showToast(errText(code));
    } finally {
      abortCtl = null;
    }
  }

  /* ---------------- 跟随定位 ---------------- */
  var composerEl = null;
  var cardEl = null;
  var lastPos = "";
  var hiddenSince = 0;

  /* 重新发现 composer：定位循环停摆后恢复时用。 */
  function rediscover() {
    composerEl = null;
    cardEl = null;
    // 换了 composer 节点：旧的廉价指纹已无意义，否则会拿旧文本误短路一次
    state.lastCheapText = null;
    var found = findComposer();
    if (found) {
      composerEl = found;
      cardEl = cardOf(found);
      syncDraftBaseline(readDraftCanonical(found));
    }
  }

  /* ---------------- 会话模型识别（实时跟随） ----------------
   * 从工具行的模型按钮读出标签文本，交给主进程反查可用路由。
   *
   * 为什么读 DOM 而不是 React state：当前选中的模型存在 React 内部 state 里，
   * 渲染端没有任何公开方式读到它；工具行按钮的 aria-label 是唯一可得的信号。
   * 因此这是"尽力跟随"：读不到或反查失败时，主进程会回落到 config.json 的默认值，
   * 不会因此报错。
   *
   * 判据与 anchorFor 共用：模型按钮是工具行里含 "/" 且不是已知功能按钮的那一颗
   * （aria 形如 "<provider>/<model> <思考档位>"）。 */
  var MODEL_EXCLUDE_RE = /发送|停止|添加上下文|切换模式|上下文|后台任务|send|stop/i;

  /** 在卡片工具行里找模型按钮，返回 { el, label, rect } 或 null。 */
  function findModelButton(card) {
    if (!card) return null;
    var cr = card.getBoundingClientRect();
    var best = null;
    var btns = card.querySelectorAll("button, [role='button']");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var r;
      try {
        r = b.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      if (r.width < 16 || r.height < 16 || r.height > 44) continue;
      if (r.top < cr.top + cr.height * 0.45) continue;
      // 自己的浮层不算
      if (b.closest && b.closest("#zpe-btn-wrap")) continue;
      var label =
        (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "");
      if (!/[\\/]/.test(label)) continue;
      if (MODEL_EXCLUDE_RE.test(label)) continue;
      if (!best || r.left < best.rect.left) {
        best = { el: b, label: label.trim(), rect: r, text: (b.textContent || "").trim() };
      }
    }
    return best;
  }

  /** 取当前会话模型的标签文本（供上报）。取不到返回空串。 */
  function currentModelLabel() {
    try {
      var card = cardEl || (composerEl ? cardOf(composerEl) : null);
      var m = findModelButton(card);
      if (!m) return "";
      // 优先 aria-label（最稳定），退回 title，最后用可见文本
      return m.label || m.text || "";
    } catch (e) {
      return "";
    }
  }

  /**
   * 计算 ✨ 的落点。
   *
   * 实测工具行布局（ZCode 3.16.3，卡片宽 861）：
   *   添加上下文 345 | 切换模式 377-488 | 后台任务 493-531 | …… 空隙 …… | 上下文用量 900-928 | 模型选择器 932-1150 | 发送 1153
   * 模型选择器左侧只有 4px 空隙 —— 按"贴模型选择器左侧"摆放会压在「上下文用量」按钮上。
   * 因此优先插到左侧按钮簇的末尾（那才是这一行放新工具按钮的位置），
   * 只有在左侧簇明显不可用时才退回"模型选择器左侧"。
   */
  function anchorFor(card) {
    var cr = card.getBoundingClientRect();
    var name = function (b) {
      return (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "");
    };
    var BTN_W = 28;
    var GAP = 8;

    /* ---- 落点重叠自检（纯矩形计算） ----
     * 必须用 top+height / left+width 推导右下角，不能直接读 r.bottom / r.right：
     * 测试 mock 的按钮矩形可能缺 bottom 字段，直接读会得到 undefined，
     * 比较恒为 false —— 于是"看起来全绿"，实际照样压住原生按钮。 */
    function rectRight(r) {
      return typeof r.right === "number" ? r.right : r.left + (r.width || 28);
    }
    function rectBottom(r) {
      return typeof r.bottom === "number" ? r.bottom : r.top + (r.height || 28);
    }
    function rectsOverlap(l, t, w, h, r) {
      return l < rectRight(r) + 4 && l + w > r.left - 4 && t < rectBottom(r) + 4 && t + h > r.top - 4;
    }
    function fitsAnywhere(l, t, w, h, rects) {
      for (var i = 0; i < rects.length; i++) {
        if (rectsOverlap(l, t, w, h, rects[i])) return false;
      }
      return true;
    }
    /* 统一收尾：候选落点与任何原生按钮相交时，沿同一行左右步进找空隙；
     * 找不到空隙宁可返回 hidden（按钮隐藏），也绝不压在原生 UI 上。 */
    function settle(cand, via) {
      var W = BTN_W;
      var H = 28;
      var rects = [];
      for (var i = 0; i < row.length; i++) rects.push(row[i].r);
      if (fitsAnywhere(cand.left, cand.top, W, H, rects)) {
        return { left: cand.left, top: cand.top, via: via };
      }
      var step = 8;
      for (var k = 1; k <= 24; k++) {
        var tryLeft = cand.left - step * k;
        if (tryLeft >= cr.left && fitsAnywhere(tryLeft, cand.top, W, H, rects)) {
          return { left: tryLeft, top: cand.top, via: via + "-shift" };
        }
        var tryRight = cand.left + step * k;
        if (tryRight + W <= cr.right && fitsAnywhere(tryRight, cand.top, W, H, rects)) {
          return { left: tryRight, top: cand.top, via: via + "-shift" };
        }
      }
      return { left: null, top: null, via: "hidden" };
    }

    // 收集工具行按钮：下半部、尺寸像图标或小胶囊
    var row = [];
    var btns = card.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var r = b.getBoundingClientRect();
      if (r.width < 16 || r.height < 16 || r.height > 44) continue;
      if (r.top < cr.top + cr.height * 0.45) continue;
      row.push({ el: b, r: r, label: name(b) });
    }
    if (!row.length) {
      return { left: cr.right - 40, top: cr.bottom - 34, via: "no-row" };
    }

    // 行内统一 top（取出现最多的那个，容错 1px）
    var rowTop = row[0].r.top;
    var sameRow = row.filter(function (x) {
      return Math.abs(x.r.top - rowTop) <= 2;
    });
    if (sameRow.length) row = sameRow;

    var model = null;
    var leftClusterRight = -Infinity;
    var mid = cr.left + cr.width * 0.5;
    var modelBtn = findModelButton(card);
    for (var j = 0; j < row.length; j++) {
      var it = row[j];
      // 模型选择器：与 findModelButton 同一判据，保证定位与上报不会各说各话
      if (modelBtn && it.el === modelBtn.el && !model) model = it;
      // 左侧簇：中心点落在卡片左半边的按钮
      if (it.r.left < mid && it.r.right > leftClusterRight) leftClusterRight = it.r.right;
    }

    // 首选：左侧簇末尾右侧
    if (leftClusterRight > -Infinity && leftClusterRight + GAP + BTN_W < cr.right) {
      return settle({ left: leftClusterRight + GAP, top: rowTop }, "cluster");
    }
    // 退路：模型选择器左侧（仅当那里真的空得下）
    if (model && model.r.left - GAP - BTN_W > cr.left) {
      return settle({ left: model.r.left - GAP - BTN_W, top: model.r.top }, "model");
    }
    return settle({ left: cr.right - 40, top: cr.bottom - 34 }, "fallback");
  }

  /** @param {boolean} [force] 强制重算落点（忽略矩形签名缓存） */
  function place(force) {
    if (!alive) return;
    try {
      if (!composerEl || !composerEl.isConnected) {
        var found = findComposer();
        if (found) {
          composerEl = found;
          cardEl = cardOf(found);
          syncDraftBaseline(readDraftCanonical(found));
          renderButtons();
        }
      } else if (!cardEl || !cardEl.isConnected) {
        cardEl = cardOf(composerEl);
      }

      if (!composerEl || !cardEl) {
        if (state.hidden !== true) {
          wrap.style.display = "none";
          state.hidden = true;
        }
        return;
      }

      var r = composerEl.getBoundingClientRect();
      var cr = cardEl.getBoundingClientRect();
      // 输入框可见性：矩形在屏内 + 中心点命中自身（防设置页/模态盖住）
      var onScreen =
        r.width > 60 &&
        r.height > 14 &&
        r.bottom > 0 &&
        r.top < window.innerHeight &&
        cr.width > 60 &&
        cr.bottom > 0 &&
        cr.top < window.innerHeight;

      if (onScreen) {
        try {
          var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!hit || hitIsThroughRoot(hit)) onScreen = false;
          else if (!(hit === composerEl || composerEl.contains(hit) || hit.contains(composerEl) || isOwn(hit))) {
            // 卡片内的装饰层不算遮挡
            if (!(cardEl.contains(hit) && cardEl.contains(composerEl))) onScreen = false;
          }
        } catch (e) {}
      }

      if (!onScreen) {
        if (!hiddenSince) hiddenSince = Date.now();
        if (Date.now() - hiddenSince > 400) {
          if (wrap.style.display !== "none") wrap.style.display = "none";
          if (state.hidden !== true) state.hidden = true;
          if (diffCard.style.display !== "none") diffCard.style.display = "none";
        }
        return;
      }
      hiddenSince = 0;

      /* 每帧开销收敛：卡片矩形没变时直接复用上一帧落点。
       * 不做这层缓存的话，60fps 下每帧都要 querySelectorAll + 全量按钮
       * getBoundingClientRect + elementFromPoint，而 lastPos 守卫恰恰证明
       * 绝大多数帧的落点根本没变。
       * force=true 时强制重算（400ms 兜底定时器用），防止"卡片矩形不变但
       * 工具行按钮增减"这种变化被漏掉。 */
      var csig = [r2(cr.left), r2(cr.top), r2(cr.width), r2(cr.height)].join(",");
      var a;
      if (
        !force &&
        csig === state.lastCardSig &&
        state.lastAnchor &&
        state.lastAnchor.via !== "hidden" &&
        state.lastAnchor.left !== null
      ) {
        a = state.lastAnchor;
      } else {
        a = anchorFor(cardEl);
        state.lastCardSig = csig;
      }
      if (a.left === null) {
        // 找不到不压原生按钮的空隙：隐藏自己，绝不遮挡宿主 UI。
        // 注意只退出这一帧的定位，不 return 掉更外层的状态维护。
        if (wrap.style.display !== "none") wrap.style.display = "none";
        state.hidden = true;
        state.anchorDegraded = true;
        state.lastAnchor = { left: null, top: null, via: a.via || "hidden" };
        return;
      }
      var left = a.left;
      var top = a.top;
      state.lastAnchor = { left: a.left, top: a.top, via: a.via || "cluster" };

      /* 定位劣化显式化：非 cluster 路径（model / fallback / *-shift）意味着
       * 工具行布局已经不是我们认识的样子，持续 5s 就提示一次。
       * 以前 via 只存不报，用户只看到按钮位置不对，开发者只能翻源码猜。 */
      var via = a.via || "cluster";
      if (via !== "cluster") {
        if (!state.anchorSince) state.anchorSince = Date.now();
        if (!state.anchorWarned && Date.now() - state.anchorSince > 5000) {
          state.anchorWarned = true;
          showToast("按钮位置可能不准（界面布局已变化）", 3000);
        }
        state.anchorDegraded = true;
      } else {
        state.anchorSince = 0;
        state.anchorDegraded = false;
      }

      // 夹到视口内
      left = Math.max(4, Math.min(left, window.innerWidth - wrap.offsetWidth - 4));
      top = Math.max(4, Math.min(top, window.innerHeight - wrap.offsetHeight - 4));

      var key = left + "," + top;
      if (key !== lastPos) {
        wrap.style.left = left + "px";
        wrap.style.top = top + "px";
        lastPos = key;
      }
      if (wrap.style.display !== "flex") wrap.style.display = "flex";
      state.hidden = false;

      var br = cardEl.getBoundingClientRect();
      wrap.setAttribute(
        "data-zpe-anchor",
        [r2(br.left), r2(br.top), r2(br.width), r2(br.height)].join(" ")
      );

      if (diffCard.style.display !== "none") positionDiff();
      if (toast.style.display !== "none") positionToast();
    } catch (e) {
      // 逐帧循环绝不能因异常退出；但要留下可观测的痕迹，否则定位问题只能是黑盒
      var msg = String((e && e.message) || e);
      state.placeError = msg;
      // 只报首次，避免 60fps 刷屏
      if (!state.placeErrorLogged) {
        state.placeErrorLogged = true;
        try {
          console.warn("[zpe] place error:", msg);
        } catch (e2) {}
      }
    }
  }

  /* 定位调度：rAF 为主（与渲染同步，最平滑），setInterval 为辅。
   *
   * 为什么必须有 setInterval 兜底：Chromium 在窗口隐藏 / 最小化 / 后台标签时
   * 会暂停 requestAnimationFrame。用 rAF 单独驱动时，窗口切回前台后循环可能
   * 已彻底停摆 —— 实测表现为按钮停在旧位置（工具行重排后压在原生按钮上），
   * 且 __zpeState() 里 draftLen === -1（composer 引用丢失）。setInterval 不受
   * 该节流影响（后台时会被降频到 1Hz，但仍在跑），窗口回到前台即可立即校正。 */
  var rafScheduled = false;
  function scheduleFrame() {
    rafScheduled = false;
    place();
  }
  function requestFrame() {
    if (rafScheduled) return;
    rafScheduled = true;
    try {
      rafId = requestAnimationFrame(scheduleFrame);
    } catch (e) {
      scheduleFrame();
    }
  }

  /* ---------------- 事件 ---------------- */
  btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (btn.getAttribute("aria-disabled") === "true" && state.phase !== "busy") {
      var draft = composerEl ? readDraftCanonical(composerEl) : "";
      if (draft === "") showToast("请先输入需要增强的提示词");
      else showToast(btn.title || "暂不可用");
      return;
    }
    startEnhance();
  });

  undoBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    doUndo();
  });

  intensityBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    // 进行中不允许切换：否则用户会以为能改变正在跑的这一次
    if (state.phase === "busy") return;
    state.intensity = state.intensity === "deep" ? "standard" : "deep";
    saveIntensity(state.intensity);
    renderButtons();
    showToast(
      state.intensity === "deep"
        ? "已切到深度：六段式结构化，补齐边界与验收"
        : "已切到标准：紧凑改写，保持原句形态",
      2400
    );
  });

  diffBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (diffCard.style.display === "none") openDiff();
    else closeDiff(true);
  });

  btn.addEventListener("mouseenter", function () {
    if (state.phase !== "busy" && btn.getAttribute("aria-disabled") !== "true") {
      btn.style.opacity = "1";
      btn.style.background = "rgba(128,128,128,.16)";
    }
  });
  btn.addEventListener("mouseleave", function () {
    btn.style.background = "transparent";
    renderButtons();
  });
  undoBtn.addEventListener("mouseenter", function () {
    undoBtn.style.opacity = "1";
    undoBtn.style.background = "rgba(128,128,128,.16)";
  });
  undoBtn.addEventListener("mouseleave", function () {
    undoBtn.style.background = "transparent";
    undoBtn.style.opacity = ".75";
  });
  intensityBtn.addEventListener("mouseenter", function () {
    if (state.phase === "busy") return;
    intensityBtn.style.opacity = "1";
    intensityBtn.style.background = "rgba(128,128,128,.16)";
  });
  intensityBtn.addEventListener("mouseleave", function () {
    intensityBtn.style.background = "transparent";
    renderButtons();
  });
  diffBtn.addEventListener("mouseenter", function () {
    diffBtn.style.opacity = "1";
    diffBtn.style.background = "rgba(128,128,128,.16)";
  });
  diffBtn.addEventListener("mouseleave", function () {
    diffBtn.style.background = "transparent";
    diffBtn.style.opacity = ".75";
  });

  /* Esc 关闭 diff 卡：只在焦点位于卡片内时拦截。
   * 用 capture + stopPropagation 会让宿主 App 自己的 Esc 处理（关面板 / 退出模式）
   * 永远收不到事件 —— 我们的浮层没理由霸占这个键。 */
  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key !== "Escape") return;
      if (diffCard.style.display === "none") return;
      var active = document.activeElement;
      var inside = false;
      try {
        inside = !!(active && (active === diffCard || diffCard.contains(active)));
      } catch (e2) {}
      if (!inside) return;
      closeDiff(true);
      // 不调用 stopPropagation：事件继续冒泡给宿主
    },
    true
  );

  /* 草稿变化轮询（低频）：撤销栈失效判定 + 按钮置灰态。
     不用 input 事件监听：Lexical 的编辑可能不走冒泡到 document 的 input，
     且 setEditorState 不触发 input。 */
  var draftTimer = setInterval(function () {
    if (!alive) return;
    checkDraftChange();
  }, 300);

  /* 主题变化时重取配色 */
  var themeTimer = setInterval(function () {
    if (!alive) return;
    if (diffCard.style.display !== "none") applyTheme();
  }, 1500);

  /* ---------------- 启动 / 拆除 ---------------- */
  window.__zpeTeardown = function () {
    alive = false;
    window.__ZPE_ACTIVE__ = false;
    try {
      cancelAnimationFrame(rafId);
    } catch (e) {}
    clearInterval(draftTimer);
    clearInterval(themeTimer);
    try { clearInterval(placeTimer); } catch (e) {}
    clearTimeout(toastTimer);
    try {
      abortCtl && abortCtl.abort();
    } catch (e) {}
    [wrap, diffCard, toast].forEach(function (n) {
      try {
        if (n.parentNode) n.parentNode.removeChild(n);
      } catch (e) {}
    });
  };

  window.__zpeState = function () {
    return {
      phase: state.phase,
      errorCode: state.errorCode,
      stackDepth: state.stack.length,
      hasDiff: !!state.diff,
      draftLen: composerEl ? readDraftCanonical(composerEl).length : -1,
      btnTitle: btn.title,
      btnAriaDisabled: btn.getAttribute("aria-disabled"),
      anchoredToCard: wrap.getAttribute("data-zpe-anchor"),
      diffVisible: diffCard.style.display !== "none",
      lastAnchor: state.lastAnchor || null,
      placeError: state.placeError || "",
      anchorDegraded: !!state.anchorDegraded,
      anchorVia: (state.lastAnchor && state.lastAnchor.via) || "",
      // 实时跟随相关：会话模型标签（读 DOM 得到）与上一次实际使用的路由
      sessionModelLabel: currentModelLabel(),
      usedRoute: usedRoute || null,
      intensity: state.intensity,
      warnings: state.warnings || [],
      restartNeeded: !!state.restartNeeded,
      wrapRect: (function () {
        var r = wrap.getBoundingClientRect();
        return [r2(r.left), r2(r.top), r2(r.width), r2(r.height)];
      })(),
      version: VERSION,
    };
  };

  /* 主进程代码变更提示：inject-main.cjs / core/*.mjs 不能热更新，
     改了必须重启 ZCode 才生效。没有这个提示，改主进程代码的人会以为改动已生效。 */
  window.__zpeNotifyRestartNeeded = function () {
    if (!alive) return;
    state.restartNeeded = true;
    showToast("增强插件的服务端代码已更新，重启 ZCode 后生效", 8000);
    renderButtons();
  };

  /* 供真实点击走查/自动化断言用的定位信息 */
  window.__zpeRect = function () {
    var out = {};
    if (composerEl) out.composer = rectArr(composerEl.getBoundingClientRect());
    if (cardEl) out.card = rectArr(cardEl.getBoundingClientRect());
    out.btnWrap = rectArr(wrap.getBoundingClientRect());
    out.btn = rectArr(btn.getBoundingClientRect());
    if (diffCard.style.display !== "none") out.diff = rectArr(diffCard.getBoundingClientRect());
    return out;
  };

  mount();
  applyTheme();
  renderButtons();
  requestFrame();
  // 兜底调度：rAF 被浏览器在后台节流/暂停时，靠它继续维持定位与状态刷新
  var placeTimer = setInterval(function () {
    if (!alive) return;
    // 引用丢失时重新发现（窗口隐藏期间重渲染会换掉 composer 节点）
    if (!composerEl || !composerEl.isConnected || !cardEl || !cardEl.isConnected) {
      if (!composerEl || !composerEl.isConnected) rediscover();
      else cardEl = cardOf(composerEl);
    }
    // 400ms 强制重算一次：卡片矩形不变但工具行按钮增减时，签名缓存会漏检
    place(true);
  }, 400);
  // 窗口重新可见 / 获得焦点时，立刻校正一次（不等下一个 tick）
  try {
    document.addEventListener("visibilitychange", function () {
      if (!alive || document.visibilityState !== "visible") return;
      rediscover();
      place(true);
    });
    window.addEventListener("focus", function () {
      if (!alive) return;
      place(true);
    });
  } catch (e) {}
})();
