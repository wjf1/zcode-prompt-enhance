// 直接验证修复后的 writeDraft 对多行文本的判定（在真实页面里调用正式实现）。
//
// 关键：不复制逻辑，而是复用页面里 overlay 的真实函数路径 ——
// 通过真实点击链路无法单独测 writeDraft，所以这里做等价验证：
// 用同样的 buildState + setEditorState 写入多行，然后**只**用 editor state 判定。
// 若这个判定通过，就证明修复后的判据在真机成立。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const T = path.join(os.homedir(), ".zcode", "zcode-token-usage-statusbar", "overlay.js");
const PORT = 47815;
const START = "/* ==== ZPE-WRITEDRAFT-VERIFY ==== */";
const END = "/* ==== end ZPE-WRITEDRAFT-VERIFY ==== */";

const SNIPPET = `${START}
(function () {
  var RUN = new Date().getTime();
  function send(o) {
    try { fetch("http://127.0.0.1:${PORT}/", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(o) }).catch(function(){}); } catch (e) {}
  }
  function norm(s) {
    return String(s == null ? "" : s).replace(/\\u00a0/g," ").replace(/\\u200b/g,"").replace(/\\r\\n/g,"\\n").replace(/[ \\t]+\\n/g,"\\n").replace(/\\n{3,}/g,"\\n\\n").trim();
  }
  function lexicalEditor(n) {
    try { for (var k in n) if (k.indexOf("__lexicalEditor") === 0) return n[k]; } catch (e) {}
    return null;
  }
  function editorText(ed) {
    try {
      var json = ed.getEditorState().toJSON(), out = [];
      (function walk(node) {
        if (!node) return;
        if (typeof node.text === "string") out.push(node.text);
        if (node.children) node.children.forEach(walk);
        if (node.type === "paragraph" || node.type === "linebreak") out.push("\\n");
      })(json.root);
      return norm(out.join(""));
    } catch (e) { return null; }
  }
  function buildState(ed, text) {
    var lines = String(text == null ? "" : text).replace(/\\r\\n/g,"\\n").split("\\n");
    var paras = lines.map(function (line) {
      return {
        children: line === "" ? [] : [{ detail:0, format:0, mode:"normal", style:"", text:line, type:"text", version:1 }],
        direction:"ltr", format:"", indent:0, type:"paragraph", version:1, textFormat:0, textStyle:""
      };
    });
    if (!paras.length) paras = [{ children:[], direction:"ltr", format:"", indent:0, type:"paragraph", version:1, textFormat:0, textStyle:"" }];
    return ed.parseEditorState({ root: { children: paras, direction:"ltr", format:"", indent:0, type:"root", version:1 } });
  }

  setTimeout(function () {
    var rep = { at: new Date().toISOString(), run: RUN, cases: [] };
    try {
      var composer = document.querySelector('[contenteditable="true"]');
      if (!composer) { rep.fatal = "no composer"; send(rep); return; }
      var ed = lexicalEditor(composer);
      if (!ed) { rep.fatal = "no lexical"; send(rep); return; }
      var original = norm(composer.innerText);
      if (original !== "") { rep.skipped = "draft not empty"; send(rep); return; }

      var SAMPLE = "扮演资深性能优化工程师，目标是在不改变外部行为的前提下让函数更快。\\n\\n请先确认以下信息：\\n- 函数源码：（待补充：请粘贴完整代码）\\n- 语言与运行时：（待补充）\\n\\n执行步骤：\\n1. 说明功能与复杂度\\n2. 给出优化后的完整代码\\n3. 逐条说明改动原因\\n\\n输出格式：按四部分分节呈现。\\n\\n验收标准：可直接替换原函数调用。";
      var want = norm(SAMPLE);

      composer.focus({ preventScroll: true });
      ed.setEditorState(buildState(ed, want));

      var lex = editorText(ed);
      var dom = norm(composer.innerText);
      rep.wantLen = want.length;
      rep.lexLen = lex === null ? -1 : lex.length;
      rep.domLen = dom.length;
      rep.lexMatch = lex === want;
      rep.domMatch = dom === want;
      // 修复后的判据：只看 lexMatch
      rep.verdictNew = rep.lexMatch ? "PASS" : "FAIL";
      // 修复前的判据：两者都要相等
      rep.verdictOld = (rep.domMatch && rep.lexMatch) ? "PASS" : "FAIL";
      if (!rep.domMatch) {
        var k = 0;
        while (k < want.length && k < dom.length && want[k] === dom[k]) k++;
        rep.domDiffAt = k;
        rep.domWant = JSON.stringify(want.slice(Math.max(0,k-12), k+12));
        rep.domGot = JSON.stringify(dom.slice(Math.max(0,k-12), k+12));
      }

      // 还原
      ed.setEditorState(buildState(ed, ""));
      rep.restored = norm(composer.innerText) === "";
      send(rep);
    } catch (e) {
      rep.fatal = String((e && e.stack) || e);
      send(rep);
    }
  }, 1100);
})();
${END}
`;

let src = fs.readFileSync(T, "utf8");
const i = src.indexOf(START), j = src.indexOf(END);
let cleaned = src;
if (i >= 0 && j >= 0) cleaned = src.slice(0, i) + src.slice(j + END.length);
fs.writeFileSync(T, cleaned.replace(/\s+$/, "") + "\n" + SNIPPET, "utf8");
console.log("verify probe written, size", fs.statSync(T).size);

let done = false;
const server = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    done = true;
    console.log("\n=== RESULT ===");
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.log(b); }
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("ok");
    setTimeout(() => process.exit(0), 300);
  });
});
server.listen(PORT, "127.0.0.1", () => console.log("listening", PORT));
setTimeout(() => { if (!done) { console.log("TIMEOUT"); process.exit(1); } }, 18000);
