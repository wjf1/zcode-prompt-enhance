// 验证 patch 后的 asar 能被 Electron 正常加载（不启动 GUI、不干扰现有 ZCode 实例）。
//
// 做法：用 Electron 的 ASAR 读取能力直接解析入口文件 + 检查 package.json main 字段，
// 确认入口可解析、语法完整。这能在用户重启前抓出"改坏了打不开"的致命问题。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// 与 repatch_asar.mjs 的 detectAsar 相同的候选顺序（去掉 config / F:/software 旧候选）
const argIdx = process.argv.indexOf("--asar");
const explicit = argIdx > -1 ? process.argv[argIdx + 1] : process.env.ZPE_ASAR;
const cands = [
  explicit || null,
  process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || "", "Programs", "ZCode", "resources", "app.asar")
    : null,
  process.platform === "win32" ? "E:/ZCode/resources/app.asar" : null,
].filter(Boolean);
const ASAR = cands.find((c) => fs.existsSync(c));
if (!ASAR) {
  console.error("app.asar not found; pass it explicitly:\n  node tools/check-asar-loadable.mjs --asar <path>\nsearched:\n" + cands.map((c) => "  " + c).join("\n"));
  process.exit(1);
}
console.log("target:", ASAR);
const CLI = path.join(process.cwd(), ".asar-tools", "node_modules", "@electron", "asar", "bin", "asar.mjs");
const work = fs.mkdtempSync(path.join(process.env.TEMP || ".", "zpe-loadcheck-"));

let fail = 0;
const check = (name, cond, extra) => {
  if (cond) console.log("  PASS", name);
  else {
    console.log("  FAIL", name, extra === undefined ? "" : String(extra));
    fail += 1;
  }
};

try {
  console.log("[1] package.json 的 main 指向");
  execFileSync(process.execPath, [CLI, "extract-file", ASAR, "package.json"], { cwd: work, stdio: "pipe" });
  const pkg = JSON.parse(fs.readFileSync(path.join(work, "package.json"), "utf8"));
  console.log("  name:", pkg.name, "version:", pkg.version, "main:", pkg.main);
  check("有 main 字段", !!pkg.main, pkg.main);

  console.log("\n[2] 入口文件可提取且可解析");
  const mainRel = String(pkg.main || "out/main/index.js").replace(/\//g, "\\");
  execFileSync(process.execPath, [CLI, "extract-file", ASAR, mainRel], { cwd: work, stdio: "pipe" });
  const entryPath = path.join(work, path.basename(mainRel));
  const src = fs.readFileSync(entryPath, "utf8");
  check("入口已提取", fs.existsSync(entryPath), entryPath);
  check("入口非空", src.length > 100_000, src.length);

  // 入口是 ESM（package.json type=module 时）。用 --check 需要正确后缀。
  const tmpCheck = path.join(work, "entry-check.mjs");
  fs.writeFileSync(tmpCheck, src, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmpCheck], { stdio: "pipe" });
    check("作为 ESM 语法完整（--check 通过）", true);
  } catch (e) {
    const isCjs = /require\(|module\.exports/.test(src.slice(0, 2000));
    // ESM 文件里出现静态 import 就不能按 CJS 检查；这里如实报告
    check("作为 ESM 语法完整（--check 通过）", false, String(e.stderr || e.message).split("\n")[0]);
    if (isCjs) console.log("  （入口含 CJS 标记，可能是另一种模块格式）");
  }

  console.log("\n[3] 注入的两行 loader 语法独立可解析");
  const loaders = src.split("\n").filter((l) => /^;import\("file:\/\/\//.test(l.trim()) || /^\s*;import\("file:\/\/\//.test(l));
  console.log("  找到 loader 行数:", loaders.length);
  // 2 行 = 本项目 + 状态栏项目均在；状态栏注入随 ZCode 升级丢失时只有 1 行（如实报告，不算本项目失败）
  check("至少 1 行 loader（2 行 = 状态栏项目也在）", loaders.length >= 1, loaders.length);
  for (const l of loaders) {
    const m = l.match(/;\s*import\((.*)\)\.catch/);
    check("loader 语法形如 import(...).catch(...)", !!m, l.slice(0, 80));
  }

  console.log("\n[4] 两行 loader 各自指向的目录存在");
  for (const l of loaders) {
    const u = l.match(/import\("([^"]+)"\)/)?.[1];
    if (!u) continue;
    const p = decodeURIComponent(u.replace("file:///", ""));
    check("目标存在: " + path.basename(path.dirname(p)), fs.existsSync(p), p);
  }

  console.log("\n[5] unpacked 原生模块在位");
  const unpacked = path.join(path.dirname(ASAR), "app.asar.unpacked");
  let nodes = 0;
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".node")) nodes += 1;
    }
  })(unpacked);
  check(".node 文件数 > 0", nodes > 0, nodes);

  console.log("\n" + (fail === 0 ? "ALL PASS — asar 可正常加载" : fail + " FAILED — 不要重启前使用"));
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
