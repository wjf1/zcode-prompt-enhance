/**
 * overlay 源码的静态断言。
 *
 * 背景（AGENTS.md 前端 DOM 变更验收规范）：workbuddy2api-panel 事故的根因是
 * 导出弹窗新增的 id 与页面既有隐藏元素重名，导致 getElementById 恒取到旧容器，
 * 三层自动化测试全绿假阳性。这里把「id 唯一」变成可执行的断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = fs.readFileSync(path.join(HERE, "..", "overlay-prompt-enhance.js"), "utf8");

/** 抽出源码里所有 id 赋值（.id = "..." 与 setAttribute("id", "...")）。 */
function collectIds(src) {
  const ids = [];
  const re1 = /\.id\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re1.exec(src))) ids.push(m[1]);
  const re2 = /setAttribute\(\s*"id"\s*,\s*"([^"]+)"/g;
  while ((m = re2.exec(src))) ids.push(m[1]);
  return ids;
}

test("overlay 内所有 DOM id 全局唯一", () => {
  const ids = collectIds(OVERLAY);
  assert.ok(ids.length >= 5, `应至少有 5 个 id，实际 ${ids.length}`);
  const seen = new Map();
  for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(dupes, [], "存在重复 id：" + JSON.stringify(dupes));
});

test("所有新增 id 统一 zpe- 前缀", () => {
  for (const id of collectIds(OVERLAY)) {
    assert.ok(id.startsWith("zpe-"), `id 未使用 zpe- 前缀: ${id}`);
  }
});

test("所有 CSS 类名统一 zpe- 前缀或为无障碍必需（不新增裸类名）", () => {
  const classes = new Set();
  const re = /\.className\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(OVERLAY))) {
    for (const c of m[1].split(/\s+/).filter(Boolean)) classes.add(c);
  }
  for (const c of classes) {
    assert.ok(c.startsWith("zpe-"), `未加前缀的类名: ${c}`);
  }
});

test("不使用 getElementById（避免重名陷阱），改用局部引用", () => {
  assert.ok(
    !/document\.getElementById/.test(OVERLAY),
    "overlay 不应依赖 document.getElementById：重名时它会静默取到错误元素"
  );
});

test("不插入 React 管理的子树：浮层一律 appendChild 到 body", () => {
  const mounts = OVERLAY.match(/document\.body\.appendChild\(/g) || [];
  assert.ok(mounts.length >= 1, "浮层应挂到 body");
  // 不应往 composer 或卡片里插节点
  assert.ok(!/composerEl\.appendChild|cardEl\.appendChild|card\.appendChild/.test(OVERLAY));
});

test("绝不修改卡片 marginBottom（那是状态栏项目的让位边距）", () => {
  assert.ok(!/marginBottom/.test(OVERLAY), "overlay 不得触碰 marginBottom");
  assert.ok(!/margin-bottom/.test(OVERLAY), "overlay 不得触碰 margin-bottom");
});

test("写入草稿走 Lexical API，不依赖 execCommand", () => {
  assert.ok(/parseEditorState/.test(OVERLAY), "必须用 parseEditorState");
  assert.ok(/setEditorState/.test(OVERLAY), "必须用 setEditorState");
  assert.ok(
    !/execCommand\(\s*["']insertText/.test(OVERLAY),
    "execCommand('insertText') 只能写不能删，实测无法清空 Lexical，不得使用"
  );
});

test("写入后必须回读校验（DOM + editor state 双比对）", () => {
  assert.ok(/readback-mismatch/.test(OVERLAY), "必须存在回读不一致的失败分支");
  assert.ok(/editorText\(ed\)/.test(OVERLAY), "必须比对 Lexical 内部状态");
});

test("按钮用 aria-disabled 而非 disabled", () => {
  assert.ok(/aria-disabled/.test(OVERLAY));
  assert.ok(
    !/btn\.disabled\s*=/.test(OVERLAY),
    "disabled 按钮会被键盘和读屏跳过，恰好在最需要原因的用户那里不可达"
  );
});

test("遮挡判定豁免自己的浮层（防隐藏→复显循环）", () => {
  assert.ok(/isOwn/.test(OVERLAY));
  assert.ok(/#zpe-btn-wrap,#zpe-diff,#zpe-toast/.test(OVERLAY), "自己的三个浮层都要豁免");
});

test("穿透假象：命中 body/html 视为被遮挡", () => {
  assert.ok(/hitIsThroughRoot/.test(OVERLAY));
});

test("弹窗内的编辑框被排除", () => {
  assert.ok(/closest\('\[role="dialog"\]'\)/.test(OVERLAY), "必须排除 role=dialog 内的 contenteditable");
});

test("apiKey 绝不出现在渲染端源码里", () => {
  assert.ok(!/apiKey/.test(OVERLAY), "渲染端不得出现 apiKey");
  assert.ok(!/x-api-key/.test(OVERLAY), "渲染端不得自行拼上游鉴权头");
});

test("渲染端只与本机回环桥通信", () => {
  assert.ok(/127\.0\.0\.1/.test(OVERLAY));
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+/i.test(OVERLAY.replace(/https?:\/\/127\.0\.0\.1/g, "")), "渲染端不应直连外部地址");
});

test("提供 __zpeTeardown 供热更新时清理旧实例", () => {
  assert.ok(/window\.__zpeTeardown\s*=/.test(OVERLAY));
});

test("定位循环有 rAF 之外的兜底调度（窗口隐藏时 rAF 会停摆）", () => {
  assert.ok(/requestAnimationFrame/.test(OVERLAY), "应有 rAF 主调度");
  assert.ok(
    /var placeTimer = setInterval/.test(OVERLAY),
    "必须有 setInterval 兜底：Chromium 在窗口隐藏/最小化时会暂停 rAF，单靠 rAF 循环会彻底停摆"
  );
  assert.ok(/clearInterval\(placeTimer\)/.test(OVERLAY), "teardown 必须清理兜底定时器");
});

test("窗口重新可见时立刻校正定位（不等下一个 tick）", () => {
  assert.ok(/visibilitychange/.test(OVERLAY), "应监听 visibilitychange");
  assert.ok(/addEventListener\("focus"/.test(OVERLAY), "应在窗口获得焦点时重定位");
  assert.ok(/function rediscover/.test(OVERLAY), "引用丢失时要能重新发现 composer");
});

test("定位异常不被静默吞掉（留可观测痕迹）", () => {
  assert.ok(/state\.placeError/.test(OVERLAY), "place() 异常要记录到 state.placeError");
});

test("diff 渲染不只靠颜色区分增删（有删除线与图例）", () => {
  assert.ok(/text-decoration:line-through/.test(OVERLAY), "删除项必须有删除线");
  assert.ok(/新增/.test(OVERLAY) && /删除/.test(OVERLAY), "必须有文字图例");
});

test("Escape 可关闭 diff 卡", () => {
  assert.ok(/Escape/.test(OVERLAY));
});

test("diff 卡高度受视口约束（真机曾顶出屏幕，关闭按钮被挡）", () => {
  assert.ok(/diffCard\.style\.maxHeight/.test(OVERLAY), "卡片必须有 maxHeight 上限");
  assert.ok(/window\.innerHeight - MARGIN \* 2/.test(OVERLAY), "上限应按视口高度计算");
  assert.ok(/zpe-diff-body/.test(OVERLAY), "正文区需可独立收缩");
});

test("diff 卡定位最终必须夹紧在视口内", () => {
  assert.ok(
    /top = Math\.max\(MARGIN, Math\.min\(top, window\.innerHeight - diffCard\.offsetHeight - MARGIN\)\)/.test(OVERLAY),
    "无论走哪条摆放分支，最终都要夹紧"
  );
  assert.ok(
    /left = Math\.max\(MARGIN, Math\.min\(r2\(ar\.left\), window\.innerWidth - w - MARGIN\)\)/.test(OVERLAY),
    "水平方向同样要夹紧"
  );
});

test("实时跟随：请求里必须带上会话模型标签", () => {
  assert.ok(/sessionModelLabel: currentModelLabel\(\)/.test(OVERLAY), "请求体要上报会话模型标签");
  assert.ok(/function currentModelLabel/.test(OVERLAY), "要有读取标签的实现");
  assert.ok(/function findModelButton/.test(OVERLAY), "模型按钮识别要独立成函数（定位与上报共用）");
});

test("跟随失败不能报错：标签为空时仍能发请求", () => {
  // currentModelLabel 必须有 try/catch 且失败返回空串
  const m = /function currentModelLabel\(\)\s*\{[\s\S]*?\n  \}/.exec(OVERLAY);
  assert.ok(m, "找不到 currentModelLabel");
  assert.ok(/catch \(e\)\s*\{\s*return "";/.test(m[0]), "取标签失败必须返回空串而不是抛出");
});

test("定位与上报共用同一套模型按钮判据（避免各说各话）", () => {
  assert.ok(
    /var modelBtn = findModelButton\(card\)/.test(OVERLAY),
    "anchorFor 应复用 findModelButton"
  );
});
