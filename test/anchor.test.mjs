/**
 * ✨ 定位算法的回归测试。
 *
 * 用 2026-10-26 从 ZCode 3.16.3 实测得到的真实工具行矩形作为固定输入。
 * 背景：初版实现是"贴模型选择器左侧"，但实测模型选择器（x=932）与
 * 「上下文用量」按钮（x=900-928）之间只有 4px 空隙，按那个方案按钮会压在
 * 原生按钮上，用户根本无法点击。改为"插到左侧按钮簇末尾右侧"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "overlay-prompt-enhance.js"), "utf8");

function extractFn(name) {
  const m = new RegExp(`function ${name}\\(card\\)\\s*\\{`, "m").exec(SRC);
  assert.ok(m, `找不到 ${name}`);
  const start = SRC.indexOf("{", m.index);
  let depth = 0;
  for (let k = start; k < SRC.length; k += 1) {
    if (SRC[k] === "{") depth += 1;
    else if (SRC[k] === "}") {
      depth -= 1;
      if (depth === 0) return SRC.slice(m.index, k + 1);
    }
  }
  throw new Error(`${name} 括号不闭合`);
}

const anchorFor = new Function("card", extractFn("anchorFor") + "; return anchorFor(card);");

function makeCard(cardRect, buttons) {
  return {
    getBoundingClientRect: () => cardRect,
    querySelectorAll: (sel) =>
      sel === "button"
        ? buttons.map((b) => ({
            getBoundingClientRect: () => b.rect,
            getAttribute: (a) => (a === "aria-label" ? b.aria : a === "title" ? b.title || "" : null),
          }))
        : [],
  };
}

// ZCode 3.16.3 实测：视口 1280×760，卡片 [333,608,861,105]，工具行 top=673 h=28
const CARD = { left: 333, top: 608, width: 861, height: 105, right: 1194, bottom: 713 };
const REAL_BUTTONS = [
  { aria: "添加上下文", rect: { left: 345, top: 673, width: 28, height: 28, right: 373 } },
  { aria: "切换模式", rect: { left: 377, top: 673, width: 111, height: 28, right: 488 } },
  { aria: "打开运行中的后台任务：Bash 1 个，工作流 0 个，子智能体 0 个，共 1 个", rect: { left: 493, top: 673, width: 38, height: 28, right: 531 } },
  { aria: "上下文已用 109,371 / 总量 1,000,000", rect: { left: 900, top: 673, width: 28, height: 28, right: 928 } },
  { aria: "workbuddy代理/cn:deepseek-v4.1-flash 最高", rect: { left: 932, top: 673, width: 218, height: 28, right: 1150 } },
  { aria: "停止生成", rect: { left: 1153, top: 673, width: 28, height: 28, right: 1181 } },
];

function overlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function rectOf(pos) {
  return { left: pos.left, top: pos.top, width: 28, height: 28, right: pos.left + 28, bottom: pos.top + 28 };
}

test("真实布局下不与任何原生按钮重叠", () => {
  const pos = anchorFor(makeCard(CARD, REAL_BUTTONS));
  const r = rectOf(pos);
  for (const b of REAL_BUTTONS) {
    assert.ok(!overlap(r, b.rect), `压住了「${b.aria.slice(0, 20)}」：${JSON.stringify({ r, orig: b.rect })}`);
  }
});

test("落在工具行同一垂直位置", () => {
  const pos = anchorFor(makeCard(CARD, REAL_BUTTONS));
  assert.ok(Math.abs(pos.top - 673) <= 2, `top=${pos.top}`);
});

test("完全在卡片水平范围内", () => {
  const pos = anchorFor(makeCard(CARD, REAL_BUTTONS));
  assert.ok(pos.left >= CARD.left, `left=${pos.left}`);
  assert.ok(pos.left + 28 <= CARD.right, `right=${pos.left + 28}`);
});

test("插在左侧按钮簇之后，而不是挤进右侧按钮之间", () => {
  const pos = anchorFor(makeCard(CARD, REAL_BUTTONS));
  assert.ok(pos.left >= 531, `left=${pos.left}，应 >= 左侧簇末尾 531`);
});

test("不与卡片下方的状态栏区域重叠", () => {
  const pos = anchorFor(makeCard(CARD, REAL_BUTTONS));
  assert.ok(pos.top + 28 <= CARD.bottom, "按钮下沿不能越过卡片下沿");
});

test("无模型选择器时仍在卡片内", () => {
  const noModel = REAL_BUTTONS.filter((b) => !/[\\/]/.test(b.aria));
  const pos = anchorFor(makeCard(CARD, noModel));
  assert.ok(pos.left >= CARD.left && pos.left + 28 <= CARD.right, JSON.stringify(pos));
});

test("按钮全在右侧时退路不压住它们", () => {
  const rightOnly = [
    { aria: "上下文已用 1 / 100", rect: { left: 900, top: 673, width: 28, height: 28, right: 928 } },
    { aria: "p/m 最高", rect: { left: 932, top: 673, width: 218, height: 28, right: 1150 } },
  ];
  const r = rectOf(anchorFor(makeCard(CARD, rightOnly)));
  for (const b of rightOnly) assert.ok(!overlap(r, b.rect), JSON.stringify({ r, orig: b.rect }));
});

test("完全没有按钮时落到卡片内右下角", () => {
  const pos = anchorFor(makeCard(CARD, []));
  assert.ok(pos.left >= CARD.left && pos.left + 28 <= CARD.right, JSON.stringify(pos));
  assert.ok(pos.top >= CARD.top && pos.top + 28 <= CARD.bottom, JSON.stringify(pos));
});

test("窄卡片下不出界", () => {
  const narrow = { left: 100, top: 500, width: 320, height: 90, right: 420, bottom: 590 };
  const btn = [{ aria: "添加上下文", rect: { left: 110, top: 560, width: 28, height: 28, right: 138 } }];
  const pos = anchorFor(makeCard(narrow, btn));
  assert.ok(pos.left >= narrow.left && pos.left + 28 <= narrow.right + 1, JSON.stringify(pos));
});
