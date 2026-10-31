#!/usr/bin/env node
/**
 * 构建期拆分（P2）：把 core/diff.mjs 生成为 overlay 内嵌的 diff 块。
 *
 * 背景：渲染进程没有 nodeIntegration，diff 算法在 overlay 里必须有一份自包含
 * 副本。此前靠手工双份维护、test/overlay-diff.test.mjs 强制行为一致 —— 改一处
 * 忘另一处就会红。现在单一事实来源是 core/diff.mjs，本脚本在构建期机械变换
 * （剥 export、按映射重命名函数、缩进）后写入 overlay 的标记区：
 *
 *   [ZPE:DIFF:BEGIN] 行（形如块注释开头） ← 本脚本管理，勿手改
 *   ...生成的代码...
 *   [ZPE:DIFF:END] 行                     ← 本脚本管理，勿手改
 *
 * 用法：
 *   node tools/build-overlay.mjs          同步生成块（内容无变化时不写文件）
 *   node tools/build-overlay.mjs --check  只校验产物是否最新（退出码 1 = 过期）
 *
 * test/overlay-diff.test.mjs 继续保留：作为产物校验，双向比对生成块与 core 的行为。
 * 零依赖，Node ≥ 22。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CORE_DIFF = path.join(ROOT, "core", "diff.mjs");
const OVERLAY = path.join(ROOT, "overlay-prompt-enhance.js");

const BEGIN_MARK = "/* [ZPE:DIFF:BEGIN]";
const END_MARK = "/* [ZPE:DIFF:END] */";

/** 函数名映射：core 的 ESM 导出名 → overlay 内的 zpe 前缀名（computeDiff 同名保留）。 */
const RENAMES = [
  ["tokenize", "zpeTokenize"],
  ["diffSegments", "zpeDiffSegments"],
  ["diffStats", "zpeDiffStats"],
  ["segmentsToLines", "zpeSegmentsToLines"],
  ["formatStats", "zpeFormatStats"],
];

function transformCore(src) {
  let out = src;
  // 1) 去掉文件头部的模块 doc 注释（生成的块有自己的头）
  out = out.replace(/^\/\*\*[\s\S]*?\*\/\s*/, "");
  // 2) 剥 export 前缀
  out = out.replace(/^export\s+/gm, "");
  // 3) 按词边界重命名（注释里出现的同名标识符一并替换，无害）
  for (const [from, to] of RENAMES) {
    out = out.replace(new RegExp("\\b" + from + "\\b", "g"), to);
  }
  // 4) 逐行缩进 2 空格，适配 overlay IIFE 内的缩进层级
  return out
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : "  " + l))
    .join("\n");
}

function buildBlock(coreSrc) {
  const head = [
    BEGIN_MARK,
    "  本块由 tools/build-overlay.mjs 从 core/diff.mjs 自动生成 —— 手改会被覆盖。",
    "  单一事实来源是 core/diff.mjs：改算法请改那里，然后运行 node tools/build-overlay.mjs",
    "  （--check 仅校验产物是否最新）。test/overlay-diff.test.mjs 继续做行为级产物校验。",
    "  */",
  ].join("\n");
  const body = transformCore(coreSrc);
  return head + "\n" + body.replace(/\s+$/, "\n") + "  " + END_MARK;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const coreSrc = fs.readFileSync(CORE_DIFF, "utf8");
  const overlaySrc = fs.readFileSync(OVERLAY, "utf8");

  const beginIdx = overlaySrc.indexOf(BEGIN_MARK);
  const endIdx = overlaySrc.indexOf(END_MARK);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    console.error("overlay 缺少 [ZPE:DIFF:BEGIN]/[ZPE:DIFF:END] 标记区，无法定位生成块。");
    console.error("请在 overlay-prompt-enhance.js 的 diff 区段手工放置一次标记后重试。");
    process.exit(1);
  }

  const block = buildBlock(coreSrc);
  const next = overlaySrc.slice(0, beginIdx) + block + overlaySrc.slice(endIdx + END_MARK.length);

  if (next === overlaySrc) {
    console.log("overlay diff 块已是最新（与 core/diff.mjs 同步）。");
    return;
  }
  if (checkOnly) {
    console.error("overlay diff 块过期：与 core/diff.mjs 不一致。请运行 node tools/build-overlay.mjs 同步。");
    process.exit(1);
  }
  fs.writeFileSync(OVERLAY, next, "utf8");
  console.log("已重写 overlay diff 块（core/diff.mjs → overlay 标记区）。");
}

main();
