// 一次性拉取当前浮层状态（不用后台常驻，避免端口占用与进程退出问题）。
//
// 用法：node tools/peek.mjs
// 特点：每次用随机端口，注入探针后立刻收集并退出，不残留进程。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const T = path.join(os.homedir(), ".zcode", "zcode-token-usage-statusbar", "overlay.js");
const START = "/* ==== ZPE-PEEK ==== */";
const END = "/* ==== end ZPE-PEEK ==== */";

let done = false;
const server = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    done = true;
    try {
      const o = JSON.parse(b);
      console.log("\n=== " + o.at + " ===");
      console.log("phase      :", o.phase, o.errorCode ? "(" + o.errorCode + ")" : "");
      console.log("draftLen   :", o.draftLen);
      console.log("stackDepth :", o.stackDepth, "| hasDiff:", o.hasDiff);
      console.log("btn        :", JSON.stringify(o.btnRect), "aria-disabled:", o.ariaDisabled);
      console.log("btnTitle   :", o.btnTitle);
      console.log("anchor     :", JSON.stringify(o.lastAnchor));
      console.log("hitIsOwn   :", o.hitIsOwn, "| hit:", o.hitAtBtnCenter);
      console.log("composer   :", JSON.stringify(o.composerRect));
      console.log("diff       :", o.diffDisplay, JSON.stringify(o.diffRect));
      if (o.diffStats) console.log("diffStats  :", o.diffStats);
      if (o.draftHead) console.log("draftHead  :", JSON.stringify(o.draftHead));
      console.log("statusbar  :", o.statusbar, "| overlap:", o.overlapStatusBar);
      console.log("placeError :", o.placeError || "-");
      console.log("issues     :", o.issues && o.issues.length ? o.issues.join(" / ") : "none");
    } catch (e) {
      console.log(b);
    }
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("ok");
    setTimeout(() => process.exit(0), 200);
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;

  const SNIPPET = `${START}
(function () {
  function send(o) {
    try { fetch("http://127.0.0.1:${port}/", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(o) }).catch(function(){}); } catch (e) {}
  }
  function scan() {
    var rep = { at: new Date().toISOString() };
    var issues = [];
    try {
      var st = typeof window.__zpeState === "function" ? window.__zpeState() : null;
      if (!st) { rep.error = "overlay not mounted"; rep.issues = ["overlay not mounted"]; send(rep); return; }
      rep.phase = st.phase;
      rep.errorCode = st.errorCode || "";
      rep.draftLen = st.draftLen;
      rep.stackDepth = st.stackDepth;
      rep.hasDiff = st.hasDiff;
      rep.btnTitle = st.btnTitle;
      rep.lastAnchor = st.lastAnchor || null;
      rep.placeError = st.placeError || "";
      var rect = typeof window.__zpeRect === "function" ? window.__zpeRect() : {};
      rep.composerRect = rect.composer || null;
      rep.btnRect = rect.btnWrap || null;
      var btn = document.getElementById("zpe-btn");
      rep.ariaDisabled = btn ? btn.getAttribute("aria-disabled") : null;
      var wrap = document.getElementById("zpe-btn-wrap");
      if (wrap) {
        var wr = wrap.getBoundingClientRect();
        var hit = document.elementFromPoint(wr.left + wr.width/2, wr.top + wr.height/2);
        rep.hitAtBtnCenter = hit ? (hit.id || hit.tagName) : null;
        rep.hitIsOwn = !!(hit && hit.closest && hit.closest("#zpe-btn-wrap"));
        if (!rep.hitIsOwn) issues.push("按钮被遮挡");
      }
      var diff = document.getElementById("zpe-diff");
      if (diff) {
        var dr = diff.getBoundingClientRect();
        rep.diffRect = [Math.round(dr.left), Math.round(dr.top), Math.round(dr.width), Math.round(dr.height)];
        rep.diffDisplay = getComputedStyle(diff).display;
        if (rep.diffDisplay !== "none") {
          var txt = diff.textContent || "";
          var m = txt.match(/\\d+ 处改动[^·]*·[^·]*·[^·]*/);
          if (m) rep.diffStats = m[0];
          if (!/新增/.test(txt) || !/删除/.test(txt)) issues.push("diff 缺图例");
        }
      }
      var composer = document.querySelector('[contenteditable="true"]');
      if (composer) {
        var t = (composer.innerText || "").replace(/\\s+/g, " ").trim();
        if (t) rep.draftHead = t.slice(0, 80);
      }
      var bar = document.getElementById("zusage-bar");
      rep.statusbar = !!bar;
      if (bar && wrap) {
        var br = bar.getBoundingClientRect(), w2 = wrap.getBoundingClientRect();
        rep.overlapStatusBar = w2.left < br.right && w2.right > br.left && w2.top < br.bottom && w2.bottom > br.top;
        if (rep.overlapStatusBar) issues.push("与状态栏重叠");
      }
      rep.issues = issues;
    } catch (e) { rep.error = String((e && e.stack) || e); rep.issues = issues; }
    send(rep);
  }
  setTimeout(scan, 700);
})();
${END}
`;

  let src = fs.readFileSync(T, "utf8");
  const i = src.indexOf(START), j = src.indexOf(END);
  let cleaned = src;
  if (i >= 0 && j >= 0) cleaned = src.slice(0, i) + src.slice(j + END.length);
  fs.writeFileSync(T, cleaned.replace(/\s+$/, "") + "\n" + SNIPPET, "utf8");
  console.log("peek on port", port, "| overlay.js size", fs.statSync(T).size);
});

setTimeout(() => {
  if (!done) {
    console.log("TIMEOUT: 无回执（页面可能未热更新，或窗口在后台）");
    process.exit(1);
  }
}, 15000);
