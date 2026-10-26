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
  var VERSION = BOOT.version || "0.1.0";

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
    unsupported: "当前没有可用的增强模型配置",
    internal: "增强失败，请稍后重试",
    forbidden: "桥接鉴权失败",
    "draft-changed": "草稿已修改，已放弃增强结果",
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

  function cardOf(n) {
    var cr = n.getBoundingClientRect();
    var p = n.parentElement;
    var last = n;
    var i = 0;
    for (; p && p !== document.body && i < 8; p = p.parentElement, i++) {
      var r = p.getBoundingClientRect();
      if (r.height > cr.height * 8 + 80) break;
      if (isVisualBox(p)) return p;
      last = p;
    }
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
    return {
      ok: false,
      reason: "readback-mismatch",
      dom: dom,
      lexical: lex,
      want: want,
    };
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
  };
  var abortCtl = null;
  var rafId = 0;
  var alive = true;

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

  var diffBtn = el("button");
  diffBtn.id = "zpe-diffbtn";
  diffBtn.type = "button";
  diffBtn.setAttribute("aria-label", "查看差异");
  diffBtn.title = "查看差异";
  diffBtn.style.cssText = btn.style.cssText;
  diffBtn.textContent = "⇄";
  diffBtn.style.display = "none";

  wrap.appendChild(btn);
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
  function isDark() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor;
      var m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return true;
      var lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      return lum < 0.5;
    } catch (e) {
      return true;
    }
  }
  function applyTheme() {
    var dark = isDark();
    diffCard.style.setProperty("--zpe-bg", dark ? "#1e1e20" : "#ffffff");
    diffCard.style.setProperty("--zpe-fg", dark ? "#e8e8ea" : "#1c1c1e");
    diffCard.style.borderColor = dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.15)";
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
    diffBtn.style.display = state.diff ? "inline-flex" : "none";
  }

  /* ---------------- token 级 LCS diff（与 core/diff.mjs 同算法，页内自包含） ----------------
     为什么在页内重写一份而不是 import：渲染进程没有 nodeIntegration，拿不到文件系统；
     主进程 executeJavaScript 注入的是单个字符串。算法必须保持与 core/diff.mjs 一致
     （test/diff.test.mjs 与 test/overlay-diff.test.mjs 会用同一组用例双向校验）。 */
  var DIFF_TOKEN_CAP = 800;
  var TOKEN_RE = /\s+|[\u3400-\u9fff]|[A-Za-z0-9_]+|[^\s]/g;

  function zpeTokenize(text) {
    return String(text == null ? "" : text).match(TOKEN_RE) || [];
  }

  function zpeDiffSegments(before, after) {
    var a = zpeTokenize(before);
    var b = zpeTokenize(after);

    if (a.length > DIFF_TOKEN_CAP || b.length > DIFF_TOKEN_CAP) {
      var segs0 = [];
      if (before) segs0.push({ type: "del", text: String(before) });
      if (after) segs0.push({ type: "ins", text: String(after) });
      return segs0;
    }

    var n = a.length;
    var m = b.length;
    var w = m + 1;
    var table = new Uint16Array((n + 1) * w);

    for (var i = n - 1; i >= 0; i -= 1) {
      for (var j = m - 1; j >= 0; j -= 1) {
        table[i * w + j] =
          a[i] === b[j]
            ? table[(i + 1) * w + j + 1] + 1
            : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }

    var segs = [];
    function push(type, text) {
      var last = segs[segs.length - 1];
      if (last && last.type === type) last.text += text;
      else segs.push({ type: type, text: text });
    }

    var x = 0;
    var y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) {
        push("same", a[x]);
        x += 1;
        y += 1;
      } else if (table[(x + 1) * w + y] >= table[x * w + y + 1]) {
        push("del", a[x]);
        x += 1;
      } else {
        push("ins", b[y]);
        y += 1;
      }
    }
    while (x < n) {
      push("del", a[x]);
      x += 1;
    }
    while (y < m) {
      push("ins", b[y]);
      y += 1;
    }
    return segs;
  }

  function zpeDiffStats(segs) {
    var changed = 0;
    var added = 0;
    var removed = 0;
    var prevType = "same";
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var len = Array.from(s.text).length;
      if (s.type === "ins") added += len;
      else if (s.type === "del") removed += len;
      if (s.type !== "same" && prevType !== s.type) changed += 1;
      prevType = s.type;
    }
    return { changed: changed, added: added, removed: removed, delta: added - removed };
  }

  function zpeSegmentsToLines(segs) {
    var lines = [[]];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var parts = s.text.split("\n");
      for (var k = 0; k < parts.length; k++) {
        if (k > 0) lines.push([]);
        if (parts[k] !== "") lines[lines.length - 1].push({ type: s.type, text: parts[k] });
      }
    }
    return lines;
  }

  function zpeFormatStats(st) {
    var sign = st.delta >= 0 ? "+" : "-";
    return (
      st.changed +
      " 处改动 · " +
      st.added +
      " 字新增 / " +
      st.removed +
      " 字替换 · 净 " +
      sign +
      Math.abs(st.delta) +
      " 字"
    );
  }

  function computeDiff(before, after) {
    var segs = zpeDiffSegments(before, after);
    var stats = zpeDiffStats(segs);
    return { segs: segs, stats: stats, lines: zpeSegmentsToLines(segs), statsText: zpeFormatStats(stats) };
  }

  function renderDiff() {
    if (!state.diff) {
      diffCard.style.display = "none";
      return;
    }
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
    closeBtn.addEventListener("click", closeDiff);
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
  }
  function closeDiff() {
    diffCard.style.display = "none";
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

  function checkDraftChange() {
    if (!composerEl) return;
    var draft = readDraftCanonical(composerEl);
    if (draft === state.lastDraft) return;
    var top = state.stack[state.stack.length - 1];
    if (top) {
      // 我刚写入的（pendingRef）不算"用户改了"；否则整栈失效
      if (draft !== top.after && draft !== state.pendingRef) {
        state.stack = [];
        state.diff = null;
        closeDiff();
      }
      if (draft === top.after) state.pendingRef = "";
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
      showToast("恢复失败：" + (res.reason || "写入校验未通过"));
      return;
    }
    state.stack.pop();
    state.pendingRef = res.wrote;
    state.diff = null;
    state.lastDraft = readDraftCanonical(composerEl);
    closeDiff();
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
        body: JSON.stringify({ draft: draft, context: readContext() }),
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
      if (norm(result) === "" || norm(result) === norm(source)) {
        setPhase("error", "empty");
        showToast("模型没有产生改动");
        return;
      }

      // 写入 + 回读校验
      var res = writeDraft(composerEl, result);
      if (!res.ok) {
        setPhase("error", "internal", res.reason);
        showToast("写入草稿失败：" + (res.reason || "校验未通过"));
        return;
      }

      state.stack.push({ before: norm(source), after: norm(result) });
      if (state.stack.length > 8) state.stack = state.stack.slice(-8);
      state.pendingRef = norm(result);
      state.lastDraft = norm(result);

      // diff
      state.diff = computeDiff(norm(source), norm(result));

      setPhase("idle");
      renderButtons();
      if (state.diff) openDiff();
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
    var found = findComposer();
    if (found) {
      composerEl = found;
      cardEl = cardOf(found);
      state.lastDraft = readDraftCanonical(found);
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
    for (var j = 0; j < row.length; j++) {
      var it = row[j];
      // 模型选择器：aria 形如 "<provider>/<model> <effort>"
      var isModel =
        /[\\/]/.test(it.label) && !/发送|停止|添加上下文|切换模式|上下文|send|stop/i.test(it.label);
      if (isModel && (!model || it.r.left < model.r.left)) model = it;
      // 左侧簇：中心点落在卡片左半边的按钮
      if (it.r.left < mid && it.r.right > leftClusterRight) leftClusterRight = it.r.right;
    }

    // 首选：左侧簇末尾右侧
    if (leftClusterRight > -Infinity && leftClusterRight + GAP + BTN_W < cr.right) {
      return { left: leftClusterRight + GAP, top: rowTop, via: "cluster" };
    }
    // 退路：模型选择器左侧（仅当那里真的空得下）
    if (model && model.r.left - GAP - BTN_W > cr.left) {
      return { left: model.r.left - GAP - BTN_W, top: model.r.top, via: "model" };
    }
    return { left: cr.right - 40, top: cr.bottom - 34, via: "fallback" };
  }

  function place() {
    if (!alive) return;
    try {
      if (!composerEl || !composerEl.isConnected) {
        var found = findComposer();
        if (found) {
          composerEl = found;
          cardEl = cardOf(found);
          state.lastDraft = readDraftCanonical(found);
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

      var a = anchorFor(cardEl);
      var left = a.left;
      var top = a.top;
      state.lastAnchor = { left: a.left, top: a.top, via: a.via || "cluster" };
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
      state.placeError = String((e && e.message) || e);
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

  diffBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (diffCard.style.display === "none") openDiff();
    else closeDiff();
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
  diffBtn.addEventListener("mouseenter", function () {
    diffBtn.style.opacity = "1";
    diffBtn.style.background = "rgba(128,128,128,.16)";
  });
  diffBtn.addEventListener("mouseleave", function () {
    diffBtn.style.background = "transparent";
    diffBtn.style.opacity = ".75";
  });

  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key === "Escape" && diffCard.style.display !== "none") {
        closeDiff();
        e.stopPropagation();
      }
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
      wrapRect: (function () {
        var r = wrap.getBoundingClientRect();
        return [r2(r.left), r2(r.top), r2(r.width), r2(r.height)];
      })(),
      version: VERSION,
    };
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
    place();
  }, 400);
  // 窗口重新可见 / 获得焦点时，立刻校正一次（不等下一个 tick）
  try {
    document.addEventListener("visibilitychange", function () {
      if (!alive || document.visibilityState !== "visible") return;
      rediscover();
      place();
    });
    window.addEventListener("focus", function () {
      if (!alive) return;
      place();
    });
  } catch (e) {}
})();
