#!/usr/bin/env node
/**
 * 增强链路的命令行兜底入口（P4 /enhance）。
 *
 * 用途：✨ 注入浮层失效期间（ZCode 升级后注入丢失、overlay 定位失效等），
 * 由 ZCode 会话内的 /enhance 命令或 enhance 技能代为调用：把草稿直接发给
 * 增强模型，结果打印到 stdout，由用户手动复制回输入框（无浮层时无法原地回填）。
 *
 * 与注入路径的关系：复用同一套 core（provider 路由解析 + enhancer + 错误码归一化
 * + 超时竞速），绕过本地桥与三闸门 —— 这是显式的单次人工调用，不需要熔断/限流；
 * 也不跟随会话模型（CLI 看不到渲染端 DOM），走 config.json 的默认路由。
 *
 * 用法：
 *   node tools/enhance-cli.mjs "草稿文本"
 *   node tools/enhance-cli.mjs --file draft.txt
 *   echo 草稿 | node tools/enhance-cli.mjs
 *
 * 输出约定：增强结果 → stdout（干净文本，可管道）；进度点与错误 → stderr。
 * 退出码：0 成功；1 失败（中文错误信息走 stderr）。绝不打印 apiKey。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findConfig, resolveRoute } from "../core/provider.mjs";
import { enhanceDraft, describeError } from "../core/enhancer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const DEFAULTS = { provider: "", model: "", max_input_chars: 12000, timeout_ms: 60000 };

function readConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")) };
  } catch {
    return { ...DEFAULTS }; // 没有 config.json 时与主进程一致：走 provider_config 默认路由
  }
}

function countChars(text) {
  let n = 0;
  for (const _ of String(text ?? "")) n += 1;
  return n;
}

function fail(code, msg) {
  console.error(`增强失败 [${code}]: ${msg}`);
  process.exit(1);
}

function readStdin(limitBytes) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const parts = [];
    let size = 0;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    process.stdin.on("data", (d) => {
      size += d.length;
      parts.push(d);
      // 读到上限就停止积累（后续长度校验会给准确报错），避免无界内存；
      // destroy 后 end 不会触发，这里直接收尾
      if (size > limitBytes) {
        process.stdin.destroy();
        finish(Buffer.concat(parts).toString("utf8"));
      }
    });
    process.stdin.on("end", () => finish(Buffer.concat(parts).toString("utf8")));
    process.stdin.on("error", () => finish(Buffer.concat(parts).toString("utf8")));
  });
}

async function main() {
  const args = process.argv.slice(2);
  let file = null;
  let timeoutOverride = 0;
  const textParts = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--file") {
      file = args[i + 1];
      i += 1;
    } else if (a === "--timeout") {
      timeoutOverride = Number(args[i + 1]);
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log("用法：node tools/enhance-cli.mjs [\"草稿文本\" | --file <path>]\n草稿也可经 stdin 传入。结果走 stdout，错误走 stderr。");
      return;
    } else {
      textParts.push(a);
    }
  }

  const cfg = readConfig();
  let draft = "";
  if (file) {
    try {
      draft = fs.readFileSync(file, "utf8");
    } catch (e) {
      return fail("no-draft-file", `读不到草稿文件 ${file}（${e && e.message}）`);
    }
  } else if (textParts.length > 0) {
    draft = textParts.join(" ");
  } else {
    draft = await readStdin(cfg.max_input_chars * 6 + 4096);
  }

  const charCount = countChars(draft);
  if (charCount === 0) return fail("empty", "草稿为空（可传位置参数、--file 或 stdin）");
  if (charCount > cfg.max_input_chars) {
    return fail("too-long", `草稿过长：${charCount} 字（上限 ${cfg.max_input_chars}，config.json 的 max_input_chars）`);
  }

  const found = findConfig();
  if (!found.parsed) {
    return fail("unsupported", "未找到 provider 配置（~/.zcode/v2/provider_config.json）—— 请先在 ZCode 里配置模型");
  }
  const route = resolveRoute(found.parsed, { provider: cfg.provider, model: cfg.model });
  if (!route) {
    return fail("unsupported", "没有可用的 anthropic-messages provider 路由 —— 请检查 config.json 的 provider/model 或 ZCode 的模型配置");
  }
  console.error(`增强中（${route.providerName}/${route.model}，${charCount} 字）…`);

  const timeoutMs = Number.isFinite(timeoutOverride) && timeoutOverride >= 1000 ? timeoutOverride : cfg.timeout_ms;
  let result;
  try {
    result = await enhanceDraft({
      route,
      draft,
      timeoutMs,
      onProgress: () => process.stderr.write("."),
    });
  } catch (err) {
    const code = (err && err.code) || "internal";
    const d = describeError(code);
    return fail(d.code, err && err.detail ? `${d.zh}（${err.detail}）` : d.zh);
  }

  process.stdout.write(result.text + "\n");
  process.stderr.write(`\n增强完成。浮层失效期间无法原地回填 —— 请把上面的内容复制回输入框。\n`);
}

main().catch((e) => fail("internal", String((e && e.message) || e)));
