/**
 * 窗口可信判定的单测。
 *
 * 背景：桥 token 是进程级常量（永不过期），而 inject-main 原先只判
 * `wc.getType() === "window"` 就注入含 token 的 __ZPE_BOOT__。任一 window 型
 * 窗口若加载远程内容，该页面即可读到 token 并以用户 apiKey 代发请求。
 * 这里把"只信任本地协议 + 显式白名单"变成可执行断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTrustChecker, DEFAULT_PROTOCOLS } from "../core/trust.mjs";

test("默认信任本地打包资源协议", () => {
  const t = createTrustChecker();
  assert.equal(t.check("file:///F:/software/Zcode/resources/app.asar/out/renderer/index.html"), true);
  assert.equal(t.check("app://zcode/index.html"), true);
  assert.equal(t.check("chrome-extension://abc/page.html"), true);
  assert.equal(t.check("devtools://devtools/bundled/inspector.html"), true);
});

test("默认协议清单包含本地四协议", () => {
  assert.deepEqual([...DEFAULT_PROTOCOLS].sort(), ["app:", "chrome-extension:", "devtools:", "file:"]);
});

test("未在白名单的远程页面一律拒绝", () => {
  const t = createTrustChecker();
  assert.equal(t.check("https://evil.example.com/"), false);
  assert.equal(t.check("https://zcode.z.ai/"), false, "白名单为空时远程一律拒绝");
  assert.equal(t.check("http://127.0.0.1:9090/"), false, "本机 IP 也不该默认放行");
});

test("显式白名单后放行对应主机", () => {
  const t = createTrustChecker(["zcode.z.ai"]);
  assert.equal(t.check("https://zcode.z.ai/"), true);
  assert.equal(t.check("https://ZCODE.Z.AI/chat"), true, "主机名大小写不敏感");
  assert.equal(t.check("https://other.example.com/"), false);
});

test("白名单支持带端口写法与空白项", () => {
  const t = createTrustChecker(["  localhost:5173  ", "", null, "  "]);
  assert.equal(t.check("http://localhost:5173/"), true);
  assert.equal(t.check("http://localhost:9999/"), false, "端口不同不应命中");
});

test("空值 / 非字符串一律拒绝", () => {
  const t = createTrustChecker();
  assert.equal(t.check(""), false);
  assert.equal(t.check(null), false);
  assert.equal(t.check(undefined), false);
  assert.equal(t.check(123), false);
  assert.equal(t.check({}), false);
  assert.equal(t.check("not a url"), false);
  assert.equal(t.check("about:blank"), false, "无来源可验证的页面不放行");
});

test("白名单参数非数组时退化为只信任本地协议", () => {
  const t = createTrustChecker("zcode.z.ai");
  assert.equal(t.check("https://zcode.z.ai/"), false);
  assert.equal(t.check("file:///tmp/index.html"), true);
});
