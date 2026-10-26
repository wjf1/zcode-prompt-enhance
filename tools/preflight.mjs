// 注入前的最后一道静态体检：语法、boot 负载构造、必要的运行时依赖。
import fs from "node:fs";
import path from "node:path";

const HERE = process.cwd();
const OVERLAY = path.join(HERE, "overlay-prompt-enhance.js");
const INJECT = path.join(HERE, "inject-main.cjs");

let fail = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS", name);
  else {
    console.log("  FAIL", name, extra === undefined ? "" : String(extra));
    fail += 1;
  }
}

console.log("[1] overlay 语法");
const overlaySrc = fs.readFileSync(OVERLAY, "utf8");
try {
  new Function(overlaySrc);
  check("能被 new Function 解析（与 inject-main 的热更新校验同一判据）", true);
} catch (e) {
  check("能被 new Function 解析", false, e.message);
}
check("体积合理", overlaySrc.length > 20_000, overlaySrc.length);

console.log("\n[2] inject-main 语法");
const injectSrc = fs.readFileSync(INJECT, "utf8");
try {
  new Function(injectSrc);
  check("能被解析", true);
} catch (e) {
  check("能被解析", false, e.message);
}

console.log("\n[3] boot 负载字段与 overlay 消费点对齐");
const bootMatch = injectSrc.match(/(?:var|const|let)\s+boot\s*=\s*\{([\s\S]*?)\};/);
check("inject-main 里有 boot 对象", !!bootMatch);
for (const key of ["port", "token", "maxInputChars", "version"]) {
  check(`boot.${key} 被设置`, injectSrc.includes(key + ":"));
  check(`overlay 消费 ${key}`, overlaySrc.includes("BOOT." + key));
}

console.log("\n[4] overlay 的全局契约");
check("定义 __zpeTeardown（主进程热更新会调用）", /window\.__zpeTeardown\s*=/.test(overlaySrc));
check("主进程确实调用 __zpeTeardown", /__zpeTeardown/.test(injectSrc));
check("定义 __zpeState（供验收断言）", /window\.__zpeState\s*=/.test(overlaySrc));
check("定义 __zpeRect（供位置断言）", /window\.__zpeRect\s*=/.test(overlaySrc));
check("有活跃实例守卫", /__ZPE_ACTIVE__/.test(overlaySrc));

console.log("\n[5] id 唯一性（AGENTS.md 硬门禁）");
const ids = [];
const re1 = /\.id = "([^"]+)"/g;
let m;
while ((m = re1.exec(overlaySrc))) ids.push(m[1]);
const re2 = /setAttribute\(\s*"id"\s*,\s*"([^"]+)"/g;
while ((m = re2.exec(overlaySrc))) ids.push(m[1]);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
check("无重复 id", dup.length === 0, dup.join(","));
check("id 数 >= 5", ids.length >= 5, ids.length);
console.log("  ids:", ids.join(", "));

console.log("\n[6] 关键安全断言");
check("overlay 无 apiKey", !/apiKey/.test(overlaySrc));
check("inject-main 持有 apiKey（用于上游鉴权）", /apiKey/.test(injectSrc));
check("overlay 只连 127.0.0.1", overlaySrc.includes("127.0.0.1"));
check("桥 token 随机生成", /randomBytes/.test(injectSrc));
check("桥只监听回环", /listen\(0,\s*"127\.0\.0\.1"/.test(injectSrc));
check("请求体上限检查", /max_input_chars \* 6 \+ 4096/.test(injectSrc));
check("超限拒绝而非截断", /code: "too-long"/.test(injectSrc));

console.log("\n[7] 与状态栏项目的隔离");
check("overlay 不碰让位边距", !/marginBottom|margin-bottom/.test(overlaySrc));
check("唯一 id 前缀 zpe-", ids.every((i) => i.startsWith("zpe-")));
check("id 与状态栏的 zusage- 不撞", ids.every((i) => !i.includes("zusage")));

console.log("\n" + (fail === 0 ? "ALL PASS" : fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
