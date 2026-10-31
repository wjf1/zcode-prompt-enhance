// 验证 inject-main.cjs 里的 pathToFileUrl 拼接方式在 Windows 上可用，
// 且 core 模块能被该 URL 正常动态导入。
import path from "node:path";
import fs from "node:fs";

function pathToFileUrl(p) {
  const norm = p.replace(/\\/g, "/");
  return "file:///" + (norm.startsWith("/") ? norm.slice(1) : norm);
}

const here = process.cwd();
const targets = [
  "core/provider.mjs",
  "core/enhancer.mjs",
  "core/gates.mjs",
  "core/trust.mjs",
  "core/context.mjs",
  "core/versioncheck.mjs",
];

let bad = 0;
for (const t of targets) {
  const abs = path.join(here, t);
  if (!fs.existsSync(abs)) {
    console.error("missing:", abs);
    bad += 1;
    continue;
  }
  const url = pathToFileUrl(abs);
  try {
    const mod = await import(url);
    console.log("OK", t, "→", Object.keys(mod).length, "exports");
  } catch (e) {
    console.error("FAIL", t, "→", e.message);
    bad += 1;
  }
}
if (bad) process.exit(1);
console.log("all core modules importable via file url");
