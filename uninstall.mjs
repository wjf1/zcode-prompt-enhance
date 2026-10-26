// zcode-prompt-enhance —— 卸载：从 app.asar 移除本项目的注入行，还原客户端。
//
// 幂等：已卸载时重复执行无副作用。
// 只移除本项目 marker 包裹的那一行，状态栏项目（__ZUSAGE_PATCH__）的注入行保持不动。
//
// 用法：
//   node uninstall.mjs --dry-run   只报告是否含注入行
//   node uninstall.mjs             解包 → 去注入 → 重打包 → 替换
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = "__ZPE_PATCH__";
const TOOLS = path.join(HERE, ".asar-tools");
const ASAR_CLI = path.join(TOOLS, "node_modules", "@electron", "asar", "bin", "asar.mjs");

function detectAsar() {
  const argIdx = process.argv.indexOf("--asar");
  const explicit = argIdx > -1 ? process.argv[argIdx + 1] : process.env.ZPE_ASAR;
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!fs.existsSync(abs)) throw new Error(`指定的 app.asar 不存在: ${abs}`);
    return abs;
  }
  const cands = [
    (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8")).asar_path || null;
      } catch {
        return null;
      }
    })(),
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "Programs", "ZCode", "resources", "app.asar")
      : null,
    process.platform === "win32" ? "F:/software/Zcode/resources/app.asar" : null,
    process.platform === "win32" ? "E:/ZCode/resources/app.asar" : null,
    process.platform === "darwin" ? "/Applications/ZCode.app/Contents/Resources/app.asar" : null,
    process.platform === "linux" ? "/opt/ZCode/resources/app.asar" : null,
    process.platform === "linux"
      ? path.join(os.homedir(), ".local", "share", "zcode", "resources", "app.asar")
      : null,
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return path.resolve(c);
  throw new Error("app.asar not found; pass --asar <path>");
}

function hasMarker(asarPath) {
  return fs.readFileSync(asarPath).includes(Buffer.from(MARKER));
}

/** 从入口源码里删掉 marker 注释行与紧随其后的 import 行。 */
export function stripLoader(src, marker = MARKER) {
  const lines = String(src).split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (!skipping && line.includes(marker)) {
      skipping = true;
      // marker 行本身丢掉；若同一行还带有 import 也一并丢
      continue;
    }
    if (skipping) {
      if (/^\s*;import\(/.test(line) || /^\s*$/.test(line) || line.trim() === "") {
        // 继续吞掉紧随的 loader import 行与空行
        if (/^\s*;import\(/.test(line)) {
          skipping = false;
        }
        continue;
      }
      skipping = false;
    }
    out.push(line);
  }
  return out.join("\n");
}

function main() {
  const ASAR = detectAsar();
  console.log("target:", ASAR);

  if (!hasMarker(ASAR)) {
    console.log("未检测到注入标记 → 已经处于未注入状态（无需操作）。");
    return;
  }
  if (process.argv.includes("--dry-run")) {
    console.log("已注入（dry-run，未改动）。");
    return;
  }
  if (!fs.existsSync(ASAR_CLI)) throw new Error("缺少 asar 工具，请先运行一次 repatch_asar.mjs");

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "zpe-uninstall-"));
  try {
    console.log("解包 ...");
    execFileSync(process.execPath, [ASAR_CLI, "extract", ASAR, path.join(work, "src")], {
      stdio: "inherit",
    });
    const entry = path.join(work, "src", "out", "main", "index.js");
    const before = fs.readFileSync(entry, "utf8");
    const after = stripLoader(before);
    if (after === before) {
      console.log("入口里没有找到可移除的注入行（marker 只在二进制其它位置出现）。");
    } else {
      fs.writeFileSync(entry, after, "utf8");
      console.log("已移除注入行，减少字节:", Buffer.byteLength(before) - Buffer.byteLength(after));
    }
    if (after.includes("__ZUSAGE_PATCH__")) console.log("状态栏项目注入行保持不动");

    const out = path.join(work, "app.asar.clean");
    console.log("重打包 ...");
    execFileSync(
      process.execPath,
      [ASAR_CLI, "pack", path.join(work, "src"), out, "--unpack", "**/*.{dll,exe,node}"],
      { stdio: "inherit" }
    );

    const dir = path.dirname(ASAR);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const bak = path.join(dir, `app.asar.bak-zpe-uninstall-${stamp}`);
    fs.copyFileSync(ASAR, bak);
    console.log("已备份:", bak);
    fs.copyFileSync(out, ASAR);
    console.log("完成。marker 仍在:", hasMarker(ASAR) ? "是（异常）" : "否");
    console.log("请完全退出并重新打开 ZCode 使改动生效。");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
