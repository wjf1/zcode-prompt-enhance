// zcode-prompt-enhance —— asar 注入脚本。
//
// 背景：浮层按钮要贴在聊天输入框旁，ZCode 插件体系没有 composer 插槽，
// 唯一可行路径是往客户端入口（app.asar 内的 out/main/index.js）尾部追加一行 loader import。
// 每次 ZCode 升级会用干净副本替换 app.asar，注入随之丢失（按钮静默消失），
// 此时重跑本脚本即可。
//
// 与 zcode-token-usage-statusbar 共存：注入标记各自独立（__ZPE_PATCH__ vs
// __ZUSAGE_PATCH__），本脚本是「解包当前 asar → 若缺本项目的行则追加 → 重打包」，
// 因此不会覆盖对方已有的注入行。
//
// 用法：
//   node repatch_asar.mjs --dry-run     只解析并打印目标路径，不改任何文件
//   node repatch_asar.mjs               解包 → 备份 → 追加 → 重打包 → 替换
//   node repatch_asar.mjs --asar <path> 显式指定 app.asar
//   node repatch_asar.mjs --check       只检查当前 asar 是否已注入（退出码 0=已注入）
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(HERE, "inject-main.cjs");
const MARKER = "__ZPE_PATCH__";
const TOOLS = path.join(HERE, ".asar-tools");
const ASAR_CLI = path.join(TOOLS, "node_modules", "@electron", "asar", "bin", "asar.mjs");
const BACKUP_KEEP = 3;

function detectAsar() {
  const argIdx = process.argv.indexOf("--asar");
  const explicit = argIdx > -1 ? process.argv[argIdx + 1] : process.env.ZPE_ASAR;
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!fs.existsSync(abs)) throw new Error(`指定的 app.asar 不存在: ${abs}`);
    return abs;
  }
  const cands = [
    readCfgAsar(),
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "Programs", "ZCode", "resources", "app.asar")
      : null,
    process.platform === "win32" ? "E:/ZCode/resources/app.asar" : null,
    process.platform === "darwin" ? "/Applications/ZCode.app/Contents/Resources/app.asar" : null,
    process.platform === "linux" ? "/opt/ZCode/resources/app.asar" : null,
    process.platform === "linux"
      ? path.join(os.homedir(), ".local", "share", "zcode", "resources", "app.asar")
      : null,
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return path.resolve(c);
  throw new Error(
    "app.asar not found; pass it explicitly:\n  node repatch_asar.mjs --asar <path/to/app.asar>\n" +
      "searched:\n" +
      cands.map((c) => "  " + c).join("\n")
  );
}

function readCfgAsar() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
    return cfg.asar_path || null;
  } catch {
    return null;
  }
}

function asarHasMarker(asarPath) {
  // 直接读二进制找 marker：比解包快得多，且对 300MB 文件也安全
  const buf = fs.readFileSync(asarPath);
  return buf.includes(Buffer.from(MARKER));
}

function ensureTools() {
  if (fs.existsSync(ASAR_CLI)) return;
  console.log("installing @electron/asar into", TOOLS, "...");
  fs.mkdirSync(TOOLS, { recursive: true });
  if (!fs.existsSync(path.join(TOOLS, "package.json"))) {
    fs.writeFileSync(path.join(TOOLS, "package.json"), '{"name":"zpe-asar-tools","private":true}\n');
  }
  execSync("npm install @electron/asar --no-audit --no-fund", { cwd: TOOLS, stdio: "inherit" });
  if (!fs.existsSync(ASAR_CLI)) throw new Error("asar CLI still missing after install");
}

function loaderLine() {
  const url = "file:///" + LOADER.replace(/\\/g, "/");
  return (
    "\n;/*" + MARKER + " prompt-enhance loader (absolute file URL, survives inside asar)*/\n" +
    ';import(' + JSON.stringify(url) + ').catch(e=>console.error("[zpe] loader failed",e&&e.message));\n'
  );
}

function rotateBackups(asarPath) {
  const dir = path.dirname(asarPath);
  const baks = fs
    .readdirSync(dir)
    .filter((f) => /^app\.asar\.bak-zpe-/.test(f))
    .sort();
  while (baks.length >= BACKUP_KEEP) fs.rmSync(path.join(dir, baks.shift()), { force: true });
  return dir;
}

function main() {
  const ASAR = detectAsar();
  console.log("target:", ASAR);

  if (process.argv.includes("--dry-run")) {
    console.log("dry-run: 仅解析路径，未改动 app.asar");
    console.log("loader:", LOADER, fs.existsSync(LOADER) ? "(存在)" : "(缺失！)");
    console.log("marker:", MARKER, "→ 当前 asar", asarHasMarker(ASAR) ? "已注入" : "未注入");
    return;
  }

  if (process.argv.includes("--check")) {
    const has = asarHasMarker(ASAR);
    console.log(has ? "PATCHED" : "NOT_PATCHED");
    process.exit(has ? 0 : 1);
  }

  if (asarHasMarker(ASAR)) {
    console.log("已经注入过（marker 存在），无需重复 patch。");
    console.log("若按钮不出现：完全退出 ZCode 后重新打开一次。");
    return;
  }

  ensureTools();
  if (!fs.existsSync(LOADER)) throw new Error("loader missing: " + LOADER);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "zpe-asar-"));
  try {
    console.log("解包当前 app.asar ...");
    execFileSync(process.execPath, [ASAR_CLI, "extract", ASAR, path.join(work, "src")], {
      stdio: "inherit",
    });

    const entry = path.join(work, "src", "out", "main", "index.js");
    if (!fs.existsSync(entry)) throw new Error("入口不存在: " + entry);

    let src = fs.readFileSync(entry, "utf8");
    if (src.includes(MARKER)) {
      console.log("入口已含本项目的注入行，跳过追加");
    } else {
      const line = loaderLine();
      fs.appendFileSync(entry, line, "utf8");
      console.log("已追加注入行，字节数:", Buffer.byteLength(line));
    }
    // 保留对方（状态栏项目）已有的注入行：我们只 append，不动其它内容
    if (src.includes("__ZUSAGE_PATCH__")) console.log("检测到状态栏项目注入行，已原样保留");

    const out = path.join(work, "app.asar.patched");
    console.log("重打包 ...");
    execFileSync(
      process.execPath,
      [ASAR_CLI, "pack", path.join(work, "src"), out, "--unpack", "**/*.{dll,exe,node}"],
      { stdio: "inherit" }
    );

    const dir = rotateBackups(ASAR);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const bak = path.join(dir, `app.asar.bak-zpe-${stamp}`);
    fs.copyFileSync(ASAR, bak);
    console.log("已备份:", bak);

    fs.copyFileSync(out, ASAR);
    const st = fs.statSync(ASAR);
    const ok = asarHasMarker(ASAR);
    console.log("替换完成:", ASAR, Math.round(st.size / 1048576) + "MB", "marker:", ok ? "OK" : "FAILED");
    if (!ok) throw new Error("注入后 marker 未出现在新 asar 中");
    console.log("");
    console.log("下一步：完全退出 ZCode 再重新打开（注入在主进程启动时加载）。");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
