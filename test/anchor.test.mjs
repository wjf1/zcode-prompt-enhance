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

function extractFn(name, args = "card") {
  const m = new RegExp(`function ${name}\\(${args}\\)\\s*\\{`, "m").exec(SRC);
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

/* anchorFor 现在复用了 findModelButton（定位与模型上报共用同一判据），
   单独提取 anchorFor 会得到 "findModelButton is not defined"。
   这里把它依赖的常量和函数一起带上，保持被测代码与真实实现一致。 */
const anchorFor = new Function(
  "card",
  [
    'var MODEL_EXCLUDE_RE = /发送|停止|添加上下文|切换模式|上下文|后台任务|send|stop/i;',
    extractFn("findModelButton", "card"),
    extractFn("anchorFor", "card"),
    "return anchorFor(card);",
  ].join("\n")
);

function makeCard(cardRect, buttons) {
  return {
    getBoundingClientRect: () => cardRect,
    querySelectorAll: (sel) =>
      // findModelButton 用的是复合选择器；两种选择器都要返回按钮，
      // 否则 model 路径在测试里恒不可达（历史盲区）。
      sel === "button" || sel === "button, [role='button']"
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

/* ---------------- 落点重叠自检（v0.3.0 T01） ----------------
 * 背景：fallback 落点 = 卡片右下角内缩 40/34，实测与发送按钮矩形直接相交。
 * 工具行识别失败（UI 改版）时正是 fallback 生效之时 —— 也就是说
 * "安全退路"会在最需要它的时候压住发送按钮。以下三条是该修复的锚点。 */

test("真实布局下不与任何原生按钮重叠（含发送按钮）", () => {
  const pos = anchorFor(makeCard(CARD, REAL_BUTTONS));
  assert.ok(pos.left !== null, "正常布局不应隐藏");
  const r = rectOf(pos);
  for (const b of REAL_BUTTONS) assert.ok(!overlap(r, b.rect), `压住了「${b.aria}」`);
});

test("右侧簇占满时要么隐藏、要么不压任何按钮（含发送）", () => {
  const rightCluster = REAL_BUTTONS.filter((b) => b.rect.left >= 900);
  const pos = anchorFor(makeCard(CARD, rightCluster));
  if (pos.left === null) {
    assert.equal(pos.via, "hidden");
    return;
  }
  const r = rectOf(pos);
  for (const b of rightCluster) {
    assert.ok(!overlap(r, b.rect), `压住了「${b.aria}」：${JSON.stringify({ r, orig: b.rect })}`);
  }
});

test("全行被占满时返回 hidden 而不是压按钮", () => {
  const full = [];
  for (let x = CARD.left; x + 28 <= CARD.right; x += 30) {
    full.push({ aria: "填充", rect: { left: x, top: 673, width: 28, height: 28, right: x + 28 } });
  }
  const pos = anchorFor(makeCard(CARD, full));
  assert.equal(pos.left, null, "找不到空隙必须 hidden");
  assert.equal(pos.via, "hidden");
});

/* ---------------- cardOf 容器合理性校验（v0.3.0 T02） ----------------
 * 背景：cardOf 原先只要遇到"有边框/非透明背景"的祖先就当卡片。3.16.2 起
 * 输入框内部出现了带背景的模型切换条，于是那个内层容器被当成卡片，
 * 按钮 / diff 卡 / toast 三处锚点一起漂。以下用 mock DOM 覆盖该回归。 */

const cardOf = new Function(
  "document",
  "getComputedStyle",
  "n",
  [
    extractFn("isVisualBox", "n"),
    extractFn("plausibleCard", "p, compRect"),
    extractFn("cardOf", "n"),
    "return cardOf(n);",
  ].join("\n")
);

/** 每个用例自己换一个 getComputedStyle / document 实现。 */
function cardOfWith(composer, gcs, body) {
  return cardOf({ body: body || { isBody: true } }, gcs, composer);
}

/** 造一个带矩形、可查询按钮的假元素。 */
function fakeEl(rect, { styled = false, buttons = [] } = {}) {
  return {
    rect,
    styled,
    parentElement: null,
    getBoundingClientRect() {
      return this.rect;
    },
    querySelectorAll(sel) {
      if (sel !== "button") return [];
      return this.buttons.map((b) => ({ getBoundingClientRect: () => b }));
    },
    buttons,
  };
}

test("cardOf：内层带背景但不够宽时不误锚，返回到真正的卡片", () => {
  const fakeDoc = { body: { isBody: true } };
  const fakeGCS = (n) => ({
    borderTopWidth: n.styled ? "1px" : "0px",
    backgroundColor: n.styled ? "rgb(40,40,44)" : "rgba(0, 0, 0, 0)",
  });

  const composer = fakeEl({ left: 345, top: 621, width: 836, height: 40, right: 1181, bottom: 661 });
  // 内层：3.16.2 起新增的"带背景模型切换条"，宽度只有 composer 的 60%
  const inner = fakeEl({ left: 345, top: 618, width: 502, height: 46, right: 847, bottom: 664 }, {
    styled: true,
    buttons: [
      { left: 350, top: 630, width: 28, height: 28, right: 378, bottom: 658 },
      { left: 382, top: 630, width: 28, height: 28, right: 410, bottom: 658 },
      { left: 414, top: 630, width: 28, height: 28, right: 442, bottom: 658 },
    ],
  });
  // 外层：真正的卡片，宽度覆盖 composer 且下半部有工具行
  const outer = fakeEl({ left: 333, top: 608, width: 861, height: 105, right: 1194, bottom: 713 }, {
    styled: true,
    buttons: [
      { left: 345, top: 673, width: 28, height: 28, right: 373, bottom: 701 },
      { left: 377, top: 673, width: 111, height: 28, right: 488, bottom: 701 },
      { left: 932, top: 673, width: 218, height: 28, right: 1150, bottom: 701 },
    ],
  });

  composer.parentElement = inner;
  inner.parentElement = outer;
  outer.parentElement = fakeDoc.body;

  assert.equal(cardOfWith(composer, fakeGCS, fakeDoc.body), outer, "应跳过不够宽的内层容器");
});

test("cardOf：候选容器没有工具行（<2 颗按钮）时继续上溯", () => {
  const fakeDoc = { body: { isBody: true } };
  const fakeGCS = () => ({ borderTopWidth: "1px", backgroundColor: "rgb(40,40,44)" });

  const composer = fakeEl({ left: 345, top: 621, width: 836, height: 40, right: 1181, bottom: 661 });
  const wrapper = fakeEl({ left: 340, top: 610, width: 850, height: 60, right: 1190, bottom: 670 }, {
    styled: true,
    buttons: [{ left: 350, top: 630, width: 28, height: 28, right: 378, bottom: 658 }],
  });
  const outer = fakeEl({ left: 333, top: 608, width: 861, height: 105, right: 1194, bottom: 713 }, {
    styled: true,
    buttons: [
      { left: 345, top: 673, width: 28, height: 28, right: 373, bottom: 701 },
      { left: 932, top: 673, width: 218, height: 28, right: 1150, bottom: 701 },
    ],
  });

  composer.parentElement = wrapper;
  wrapper.parentElement = outer;
  outer.parentElement = fakeDoc.body;

  assert.equal(cardOfWith(composer, fakeGCS, fakeDoc.body), outer);
});

test("cardOf：无任何合格候选时兜底返回最外层祖先，绝不返回 null", () => {
  const fakeDoc = { body: { isBody: true } };
  const fakeGCS = () => ({ borderTopWidth: "0px", backgroundColor: "rgba(0, 0, 0, 0)" });

  const composer = fakeEl({ left: 345, top: 621, width: 836, height: 40, right: 1181, bottom: 661 });
  const plain = fakeEl({ left: 300, top: 600, width: 900, height: 120, right: 1200, bottom: 720 });
  composer.parentElement = plain;
  plain.parentElement = fakeDoc.body;

  const got = cardOfWith(composer, fakeGCS, fakeDoc.body);
  assert.ok(got, "绝不能返回 null：place() 会直接崩，按钮永久消失");
  assert.equal(got, plain);
});
