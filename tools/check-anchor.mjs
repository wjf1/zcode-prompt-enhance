// 用探针实测到的真实按钮矩形，离线验证 ✨ 的定位算法不会压住原生按钮。
// 真实数据来自 2026-10-26 的 dom-struct 探针（ZCode 3.16.3，视口 1280×760）。
import fs from "node:fs";
import path from "node:path";

const OVERLAY = path.join(process.cwd(), "overlay-prompt-enhance.js");
const src = fs.readFileSync(OVERLAY, "utf8");

// 抠出 anchorFor 函数体，在一个最小的假环境里跑
const m = /function anchorFor\(card\)\s*\{/m.exec(src);
if (!m) {
  console.error("找不到 anchorFor");
  process.exit(1);
}
let i = src.indexOf("{", m.index);
let depth = 0;
let end = -1;
for (let k = i; k < src.length; k += 1) {
  if (src[k] === "{") depth += 1;
  else if (src[k] === "}") {
    depth -= 1;
    if (depth === 0) {
      end = k + 1;
      break;
    }
  }
}
const fnSrc = src.slice(m.index, end);
const anchorFor = new Function("card", fnSrc + "; return anchorFor(card);");

/** 造一个假的 card，模拟真实 DOM 查询。 */
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

// 实测数据：卡片 [333,608,861,105]，工具行 top=673 h=28
const CARD = { left: 333, top: 608, width: 861, height: 105, right: 1194, bottom: 713 };
const REAL = [
  { aria: "添加上下文", rect: { left: 345, top: 673, width: 28, height: 28, right: 373 } },
  { aria: "切换模式", rect: { left: 377, top: 673, width: 111, height: 28, right: 488 } },
  { aria: "打开运行中的后台任务：Bash 1 个，工作流 0 个，子智能体 0 个，共 1 个", rect: { left: 493, top: 673, width: 38, height: 28, right: 531 } },
  { aria: "上下文已用 109,371 / 总量 1,000,000", rect: { left: 900, top: 673, width: 28, height: 28, right: 928 } },
  { aria: "workbuddy代理/cn:deepseek-v4.1-flash 最高", rect: { left: 932, top: 673, width: 218, height: 28, right: 1150 } },
  { aria: "停止生成", rect: { left: 1153, top: 673, width: 28, height: 28, right: 1181 } },
];

let fail = 0;
const check = (name, cond, extra) => {
  if (cond) console.log("  PASS", name);
  else {
    console.log("  FAIL", name, extra === undefined ? "" : JSON.stringify(extra));
    fail += 1;
  }
};
const overlaps = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

console.log("[1] 真实布局下 ✨ 落点");
const pos = anchorFor(makeCard(CARD, REAL));
const btnRect = { left: pos.left, top: pos.top, width: 28, height: 28, right: pos.left + 28, bottom: pos.top + 28 };
console.log("  ✨ rect:", JSON.stringify(btnRect));
check("落在工具行同一垂直位置", Math.abs(pos.top - 673) <= 2, pos.top);
check("完全在卡片水平范围内", pos.left >= CARD.left && pos.left + 28 <= CARD.right, pos);
check("在左侧按钮簇之后（不插在中间）", pos.left >= 531, pos.left);

for (const b of REAL) {
  check("不压住「" + b.aria.slice(0, 14) + "…」", !overlaps(btnRect, b.rect), { btn: btnRect, orig: b.rect });
}

console.log("\n[2] 与状态栏条的位置关系（状态栏在卡片下方 +24px 让位带内）");
check("✨ 不与卡片下方的状态栏区域重叠", pos.top + 28 <= CARD.bottom, pos.top + 28);

console.log("\n[3] 极端布局的兜底");
{
  // 没有模型选择器
  const noModel = REAL.filter((b) => !/[\\/]/.test(b.aria));
  const p = anchorFor(makeCard(CARD, noModel));
  check("无模型选择器时仍给出卡片内坐标", p.left >= CARD.left && p.left + 28 <= CARD.right, p);
}
{
  // 按钮全挤在右边（左侧无簇）
  const rightOnly = [
    { aria: "上下文已用 1 / 100", rect: { left: 900, top: 673, width: 28, height: 28, right: 928 } },
    { aria: "p/m 最高", rect: { left: 932, top: 673, width: 218, height: 28, right: 1150 } },
  ];
  const p = anchorFor(makeCard(CARD, rightOnly));
  const pr = { left: p.left, top: p.top, width: 28, height: 28, right: p.left + 28, bottom: p.top + 28 };
  check("退路仍不压住右侧按钮", !overlaps(pr, rightOnly[0].rect) && !overlaps(pr, rightOnly[1].rect), p);
}
{
  // 完全没有按钮
  const p = anchorFor(makeCard(CARD, []));
  check("无按钮时落到卡片右下角且不出界", p.left >= CARD.left && p.left + 28 <= CARD.right, p);
}
{
  // 窄卡片
  const narrow = { left: 100, top: 500, width: 320, height: 90, right: 420, bottom: 590 };
  const btn = [{ aria: "添加上下文", rect: { left: 110, top: 560, width: 28, height: 28, right: 138 } }];
  const p = anchorFor(makeCard(narrow, btn));
  check("窄卡片下仍在界内", p.left >= narrow.left && p.left + 28 <= narrow.right + 1, p);
}

console.log("\n" + (fail === 0 ? "ALL PASS" : fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
