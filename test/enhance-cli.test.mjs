/**
 * P4 /enhance 兜底链路的测试。
 *
 * CLI 行为测试只覆盖"不联网就能判定的分支"（空草稿 / 过长草稿），
 * 真实模型端到端沿用 tools/e2e-model.mjs（需要本机 provider 存活，不进 CI）。
 * 另含 command / skill 产物的静态断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CLI = path.join(ROOT, "tools", "enhance-cli.mjs");

function runCli(input, extraArgs = []) {
  return spawnSync(process.execPath, [CLI, ...extraArgs], {
    input,
    encoding: "utf8",
    timeout: 20000,
  });
}

function readLocalMaxInputChars() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    return Number.isFinite(Number(cfg.max_input_chars)) && Number(cfg.max_input_chars) > 0
      ? Number(cfg.max_input_chars)
      : 12000;
  } catch {
    return 12000;
  }
}

test("CLI：空草稿（stdin 空）→ 退出码 1，提示草稿为空，不发起网络请求", () => {
  const r = runCli("");
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes("草稿为空"), `stderr: ${r.stderr}`);
  assert.equal(r.stdout, "");
});

test("CLI：全空白草稿 → 退出码 1", () => {
  const r = runCli("   \n\t\n");
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes("草稿为空"), `stderr: ${r.stderr}`);
});

test("CLI：全空白草稿必须在发请求前就失败（不依赖本机 provider 配置）", () => {
  /* 回归锚点：曾只用 charCount === 0 判空，"   \n\t" 会当成合法草稿，
   * 先去查 provider 配置 —— CI 上没有该配置时先报 unsupported 把真实原因盖掉，
   * 本机则真的发一次网络请求。正确行为是 trim() 后判空、立刻失败：
   * stderr 里只有"草稿为空"，不出现"增强中"（说明没进入请求阶段）。 */
  const r = runCli("   \n\t\n");
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes("草稿为空"), `stderr: ${r.stderr}`);
  assert.ok(!r.stderr.includes("增强中"), "空白草稿不应进入请求阶段：" + r.stderr);
  assert.ok(!r.stderr.includes("未找到 provider 配置"), "空值判定必须先于配置检查：" + r.stderr);
  assert.equal(r.stdout, "");
});

test("CLI：超长草稿（--file）→ 退出码 1，提示过长与上限值", () => {
  const limit = readLocalMaxInputChars();
  const f = path.join(os.tmpdir(), "zpe-cli-too-long-" + process.pid + ".txt");
  fs.writeFileSync(f, "字".repeat(limit * 2), "utf8");
  try {
    const r = runCli("", ["--file", f]);
    assert.equal(r.status, 1, `stderr: ${r.stderr}`);
    assert.ok(r.stderr.includes("过长"), `stderr: ${r.stderr}`);
    assert.ok(r.stderr.includes(String(limit)), "错误应包含实际上限值");
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test("CLI：--file 指向不存在的文件 → 退出码 1", () => {
  const r = runCli("", ["--file", path.join(os.tmpdir(), "zpe-cli-nope-" + process.pid + ".txt")]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("读不到草稿文件"));
});

test("CLI：脚本绝不回显 apiKey（错误路径下的输出也不含凭据）", () => {
  const r = runCli("");
  // 粗断言：完整输出里不应出现 sk- 形态的令牌
  assert.ok(!/(sk|ak)-[A-Za-z0-9]{8,}/.test(r.stdout + r.stderr));
});

test("静态断言：command 与 skill 存在且指向 enhance-cli", () => {
  const cmd = fs.readFileSync(path.join(ROOT, "commands", "enhance.md"), "utf8");
  assert.ok(cmd.includes("tools/enhance-cli.mjs"), "command 应指向 CLI 脚本");
  assert.ok(cmd.includes("$ARGUMENTS"), "command 应使用 $ARGUMENTS 接收草稿");
  assert.ok(cmd.includes("enhance-cli"), "command 应说明调用方式");

  const skill = fs.readFileSync(path.join(ROOT, "skills", "enhance", "SKILL.md"), "utf8");
  assert.ok(/^---\n/.test(skill), "SKILL.md 应有 frontmatter");
  assert.ok(/name:\s*enhance/.test(skill), "skill 名应为 enhance");
  assert.ok(skill.includes("tools/enhance-cli.mjs"), "skill 应指向 CLI 脚本");
});
