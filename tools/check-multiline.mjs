// 多行草稿的读写往返测试。
//
// 风险来源：HANDOFF §5.2 P1 —— buildState 把每行映射成一个 paragraph，
// 而 Lexical 的软换行（Shift+Enter，linebreak 节点）与硬换行（新段落）在
// 序列化/反序列化时可能不对称，导致 readback-mismatch。
// 这里用真实的 Lexical 包（若可用）或结构等价的模拟器验证往返一致性。
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.join(process.cwd(), "overlay-prompt-enhance.js"), "utf8");

function extractFn(name, args = "ed, text") {
  const m = new RegExp(`function ${name}\\(${args}\\)\\s*\\{`, "m").exec(SRC);
  if (!m) throw new Error("找不到 " + name);
  const start = SRC.indexOf("{", m.index);
  let depth = 0;
  for (let k = start; k < SRC.length; k += 1) {
    if (SRC[k] === "{") depth += 1;
    else if (SRC[k] === "}") {
      depth -= 1;
      if (depth === 0) return SRC.slice(m.index, k + 1);
    }
  }
  throw new Error(name + " 括号不闭合");
}

const normSrc = extractFn("norm", "s");
const editorTextSrc = extractFn("editorText", "ed");
const buildStateSrc = extractFn("buildState");

/* 结构等价的 Lexical 模拟器：parseEditorState 存 JSON，getEditorState().toJSON() 原样还给，
   editorText 用 overlay 自己的实现来读 —— 这恰好能验证 "写入结构 → 读回文本" 是否对称。 */
function makeEd() {
  let state = null;
  return {
    parseEditorState(json) {
      return JSON.parse(JSON.stringify(json));
    },
    setEditorState(s) {
      state = s;
    },
    getEditorState() {
      return { toJSON: () => JSON.parse(JSON.stringify(state)) };
    },
  };
}

const sandbox = {};
const runner = new Function(
  "sandbox",
  `
  var norm = ${normSrc};
  var editorText = ${editorTextSrc};
  var buildState = ${buildStateSrc};
  return { norm, editorText, buildState };
  `
);
const api = runner(sandbox);

const CASES = [
  "",
  "单行文本",
  "第一行\n第二行",
  "第一行\n\n第三行",
  "a\nb\nc",
  "带 trailing newline\n",
  "\n开头是空行",
  "多行\n中文内容\n混合 English words\n最后一行",
  "行尾有空格   \n下一行",
  "特殊字符 <raw_prompt> 与 </conversation_context>",
  "emoji 😀 与 CJK 中文混排\n第二行",
];

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS", name);
  else {
    console.log("  FAIL", name, extra === undefined ? "" : JSON.stringify(extra));
    fail += 1;
  }
}

console.log("[1] 写入 → 从 editor state 读回，应等于规范化后的原文");
for (const text of CASES) {
  const ed = makeEd();
  const want = api.norm(text);
  const state = api.buildState(ed, want);
  ed.setEditorState(state);
  const got = api.editorText(ed);
  check(JSON.stringify(text).slice(0, 40), api.norm(got) === want, { want, got });
}

console.log("\n[2] 结构完整性：每个非空行都应成为一个 paragraph");
for (const text of CASES) {
  const ed = makeEd();
  const want = api.norm(text);
  const state = api.buildState(ed, want);
  const paras = state.root.children;
  const nonEmpty = want === "" ? 0 : want.split("\n").length;
  check(
    "段落数 " + JSON.stringify(text).slice(0, 30),
    paras.length === nonEmpty || (nonEmpty === 0 && paras.length === 1),
    { paras: paras.length, expect: nonEmpty }
  );
}

console.log("\n[3] 每个 text 节点字段齐全（Lexical 缺字段会抛）");
{
  const ed = makeEd();
  const state = api.buildState(ed, "测试一行");
  const para = state.root.children[0];
  const requiredPara = ["children", "direction", "format", "indent", "type", "version", "textFormat", "textStyle"];
  for (const k of requiredPara) check("paragraph." + k + " 存在", k in para, Object.keys(para));
  const tnode = para.children[0];
  const requiredText = ["detail", "format", "mode", "style", "text", "type", "version"];
  for (const k of requiredText) check("text." + k + " 存在", k in tnode, Object.keys(tnode));
  check("root.type = root", state.root.type === "root");
  check("root 有 version", "version" in state.root);
}

console.log("\n[4] 空文本产出单个空段落（不是零段落）");
{
  const ed = makeEd();
  const state = api.buildState(ed, "");
  check("children 长度 1", state.root.children.length === 1, state.root.children.length);
  check("该段落 children 为空", state.root.children[0].children.length === 0);
}

console.log("\n[5] 往返两次仍然稳定（幂等）");
for (const text of CASES) {
  const ed = makeEd();
  const want = api.norm(text);
  ed.setEditorState(api.buildState(ed, want));
  const once = api.editorText(ed);
  ed.setEditorState(api.buildState(ed, once));
  const twice = api.editorText(ed);
  check("两次一致 " + JSON.stringify(text).slice(0, 30), once === twice, { once, twice });
}

console.log("\n" + (fail === 0 ? "ALL PASS" : fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
