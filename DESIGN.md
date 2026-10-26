# ZCode 提示词增强插件 —— 对标分析与开发方案

> 对标对象：https://github.com/wjf1/dsh-prompt-enhance （DeepSeek Harness 插件）
> 调研日期：2026-10-26　目标客户端：ZCode Desktop 3.16.3（`E:\ZCode`）
> 状态：**方案阶段**（未写一行业务代码）

---

## 0. 结论速览

1. **ZCode 没有对应的官方插件。** 官方插件市场 66 个条目里没有任何提示词增强 / 润色 / 改写类插件。
2. **官方预留过这个功能，但没接线。** `app.asar` 内有整套 `chat.promptEnhance.*` 中英文文案（含 `empty` / `unsupported` / `cancelled` / `error` 分支）和 `prompt_enhance` 埋点来源映射，但**没有任何渲染端调用点**——按钮不存在，功能不可用。
3. **不能用"正规插件"实现"输入框旁按钮 + 就地回填"。** ZCode 插件体系的 7 个扩展点里，最接近的 `ui.surfaces`（MCP App）只能是会话级**侧栏面板**，且 `ui/message` 的语义是「确认后直接发送」而非「回填草稿」，沙箱内也读不到用户当前草稿。`UserPromptSubmit` hook 虽能拿到 prompt 原文，但输出 schema 只允许 `additionalContext`，**没有 `updatedPrompt` 字段**，只能拦截、不能改写。
4. **唯一能真正对标的路径是 asar 注入**（修改客户端 `out/main/index.js` 尾部追加一行 loader import）。本机 `zcode-token-usage-statusbar` 已经用这种方式跑了一个多月，`overlay.js` 里已有**可以直接复用的** composer 定位实现（穿透 shadow DOM / 同源 iframe）和卡片锚点逻辑。
5. **模型调用链路已验证可用**：从 `~/.zcode/v2/provider_config.json` 取 `new-provider-4`（workbuddy 代理）的 apiKey + `http://127.0.0.1:7863/v1`，`POST /messages` 实测 **HTTP 200**，模型 `cn:deepseek-v4.1-flash` 正常返回。
6. **本项目建议独立立项**，独立 patch marker（`__ZPE_PATCH__`），不并入 token 状态栏仓库；两者共享 asar 注入层但互不依赖，`repatch` 脚本采用「解包当前 asar → 追加本项目的行 → 重打包」，因此不会覆盖对方已有的注入行。

**推荐路线：asar 注入（渲染端浮层按钮 + 主进程增强服务），分 4 期交付，P0 可在单次会话内完成。**

---

## 1. 对标分析

### 1.1 dsh-prompt-enhance 是什么

DSH（DeepSeek Harness）的插件，一个包两个半边：

| 半边 | 运行位置 | 职责 |
|---|---|---|
| 宿主半 `lib/index.js` | Node 主进程 | 注册 `POST /dsh-prompt-enhance/api/enhance`，校验会话，调 `ctx.llm.stream()` 单轮 LLM，不写历史、不带工具 |
| 浏览器半 `lib/client.js` | 渲染进程 | 通过插槽 `conversation.input.right` 挂 ✨ 按钮，读写草稿，维护 8 层撤销栈，渲染 diff 卡 |
| 提示词半 `lib/prompt.mjs` | 宿主 | system/user prompt 模板 + 输出清洗 |

**关键前提：DSH 有 `conversation.input.right` 这个 composer 插槽。这是它能做到"按钮贴着输入框"的根本原因。**

⚠️ 另需澄清：npm 上同名包 `dsh-prompt-enhance` 最新 0.3.2 是**另一个人（rongxingda）的独立实现**，与 wjf1 仓库不是同一套代码（wjf1 的 README 第 165 行自己也承认了）。两者 prompt 策略、清洗规则、交互哲学都不同。本方案两份都参考，取舍见 §5.2。

### 1.2 ZCode 与 DSH 的扩展能力差距

| 能力 | DSH | ZCode | 差距影响 |
|---|---|---|---|
| composer 插槽（按钮贴输入框） | ✅ `conversation.input.right` | ❌ 无任何前端插槽 / JS 注入机制 | **致命**，正规插件路线走不通 |
| 读写草稿 API | ✅ `props.useInput` / `inputActions.setDraft` | ❌ 只有 React 内部 hook（`replaceComposerDraft`），未暴露 | 只能靠 DOM 操作 |
| 宿主 LLM 调用 | ✅ `ctx.llm.stream()` | ⚠️ 仅 MCP App 可通过 `sampling/createMessage`；普通 MCP server 无 sampling 能力 | 需自建 HTTP 客户端 |
| 发送前改写 prompt | — | ❌ `UserPromptSubmit` 只有 `additionalContext`，无 `updatedPrompt` | 无法用 hook 实现 |
| 侧栏面板 | — | ✅ `ui.surfaces`（仅 `availability: "session"`） | 唯一正规 UI 出口 |
| Slash command | ✅ | ✅ 但被拒绝内联 shell，结果只能进对话 | 体验降级严重 |
| 生命周期 hook | ✅ | ✅ 7 个事件（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` / `Stop`） | 可用于旁路能力 |
| 状态栏 | — | ❌ 官方无此贡献点（本机状态栏是 asar 注入实现的） | 印证注入是唯一途径 |

### 1.3 官方预留但未接线的证据

```
# app.asar 中命中 2 次（中/英 i18n 定义各一次），无第三次调用点
"chat.promptEnhance.title":`增强提示词`
"chat.promptEnhance.description":`使用当前选中的模型配置润色这条草稿。`
"chat.promptEnhance.cancel":`取消增强`
"chat.promptEnhance.cancelDescription":`再次点击可取消当前这次提示词增强。`
"chat.promptEnhance.cancelled":`已取消本次提示词增强`
"chat.promptEnhance.empty":`请先输入需要增强的提示词`
"chat.promptEnhance.unsupported":`当前选中的模型暂时没有可直连的增强配置。`
"chat.promptEnhance.error":`提示词增强失败，请稍后重试。`

# 埋点来源映射（存在）
case `prompt_enhance`: return `modelTrajectory.source.promptEnhance`;
```

判定：文案与埋点常量齐备，说明官方**规划过**；但 `enhancePrompt` / `enhanceDraft` 在 `app.asar` 与 `zcode.cjs` 中均 **0 命中**，说明**渲染端和宿主端都未实现**。

📌 **行动项**：每次 ZCode 升级后重新 grep 一次 `enhancePrompt`。一旦官方发布，本项目立即弃用（见 §9 风险 R1）。

---

## 2. 路径对比与选型

| # | 路径 | 按钮贴输入框 | 就地回填草稿 | 读当前草稿 | 跨升级存活 | 工作量 |
|---|---|---|---|---|---|---|
| A | 纯 Skill + `/enhance` 命令 | ❌ | ❌（结果进对话，需手动复制） | ❌ | ✅ | 0.5 天 |
| B | MCP 工具 `enhance_prompt` | ❌ | ❌ | ⚠️ 需用户粘贴 | ✅ | 1–2 天 |
| C | MCP App 侧栏面板 | ❌（只能在侧栏） | ❌（确认后**直接发送**） | ❌（沙箱隔离） | ✅ | 4–6 天 |
| D | MCP 工具 + `UserPromptSubmit` hook 联动 | ❌ | ❌（hook 不能改文本） | ✅（hook 能拿到） | ✅ | 3 天 |
| **E** | **asar 注入（渲染端浮层）** | **✅** | **✅** | **✅** | ❌ 每次升级失效 | **5–8 天** |

### 选型：E 为主，A 作为应急兜底

理由：
- 用户要的是**对标**——也就是"点一下就地改写，保留原文可撤销"。只有 E 能做到，A/B/C/D 都是降级形态。
- E 的**基础设施本机已经存在**：token 状态栏项目已验证 asar 注入可行、已跑一个多月、`overlay.js` 里 composer 定位逻辑可直接抄。实际增量工作量比从零做 C 还小。
- E 的硬伤（升级失效）本机已经形成运维习惯（`repatch_asar.mjs` + 重启），且 P3 会加"版本变更检测 + 一键重打"提示。
- **同时交付 A 形态**（一个 200 行的 skill + command），作为 E 失效期间的兜底，成本极低。

### 为什么不选 C（唯一"正规"路径）

C 表面上是官方支持的，但三个硬约束让它无法对标：
1. `ui/message` = `sendFollowUp` → `sendText`，**是发送不是回填**。无用户手势时宿主还会弹 `sQe` 确认框（5 秒手势窗口内无需弹）。
2. 沙箱内 `guest` 无法访问主窗口 DOM，**读不到用户草稿**——用户必须把草稿粘到侧栏里。
3. `availability` 被 zod 锁死为 `"session"`，**不能贴在输入框旁**；远程会话/受限工作区直接不可用。

这三条叠加后，C 的实际体验是"开侧栏 → 粘贴草稿 → 点增强 → 确认 → 消息被直接发出"，与"在输入框旁点一下就地改写"不是同一个产品。

---

## 3. 已验证的技术事实（可直接依赖）

| 事实 | 证据 |
|---|---|
| 输入框是 **Lexical contenteditable**，不是 textarea | `diag-0.json`：`shallow.textarea=0`、`[contenteditable="true"]=1`、`[role="textbox"]=1` |
| composer 卡片可以用「第一个有边框/背景的祖先」定位 | `overlay.js` 的 `cardOf()`，实测稳定 |
| 穿透 shadow DOM / 同源 iframe 找 composer 的实现在本机可用 | `overlay.js` 的 `deepFind()`（`COMPOSER_SEL` 五选择器 + `role=dialog` 排除 + `innerHeight*0.45` 下半屏判定） |
| 渲染进程可通过 `wc.executeJavaScript` 注入任意 JS，且支持按 mtime 热更新 | `inject-main.cjs` 的 `hotReloadIfChanged()` |
| asar 注入点 = `out/main/index.js` 尾部追加一行 `import(...)` | `repatch_asar.mjs` 头部注释 + `MARKER` 幂等守卫 |
| provider 凭据 + baseUrl 可直接用于 `POST /messages` | 实测 `new-provider-4` → `http://127.0.0.1:7863/v1/messages` → **HTTP 200**，返回 `{"text":"OK"}` |
| 官方市场无同类插件 | 66 条 marketplace 条目按 `prompt/enhanc/提示/润色/rewrite` 全无命中 |

⚠️ **未验证项（P0 必须先打掉）**：`document.execCommand('insertText')` 能否写入 Lexical 并让 React state 同步。见 §9 风险 R2 与 §6.4 的三级降级方案。

---

## 4. 目标产品形态（交互规格）

严格对标 wjf1 版的交互契约：

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  草稿区域（用户输入）                            │
│                                                 │
│  [📎] [✨]              [模型选择器 ▾]  [发送]  │  ← ✨ 插在工具行，模型选择器之前
└─────────────────────────────────────────────────┘
```

### 4.1 状态机

```
        草稿为空                    ┌──────────┐
  ──────────────────────►  disabled │ idle     │◄──────────────┐
                                      └────┬─────┘               │
                                  点击 ✨   │                     │
                                            ▼                     │
                                      ┌──────────┐   AbortError   │
                                      │  busy    │───────────────┤
                                      │ (转圈)   │  （再点=取消） │
                                      └────┬─────┘               │
                              成功且草稿未变 │  失败              │
                                            ▼                     │
                            ┌───────────────────────────┐        │
                            │ enhanced：草稿已原地替换   │        │
                            │ 出现 ↺ 撤销 / ⇄ 差异       │────────┘
                            └───────────────────────────┘  用户编辑草稿
                                                            （清空撤销栈）
```

### 4.2 行为规格

| # | 规则 | 说明 |
|---|---|---|
| 1 | 空草稿（`trim()===''`）按钮置灰 | busy 态**反而可点**（那是取消） |
| 2 | 点击 → 按钮换 Spinner，`title="正在增强（点击取消）"` | 再点 → `AbortController.abort()`，不提示、不改草稿 |
| 3 | 成功 → **原地替换**草稿，不弹对话框、不自动发送 | 按钮变 `↺ 恢复原文` |
| 4 | 撤销栈深度 **8** | 对增强结果再增强可逐层回退 |
| 5 | 成功前二次读草稿比对 | `readDraft() !== source` → 放弃结果，提示「草稿已修改，已放弃增强结果」 |
| 6 | 用户自己改草稿 → 整栈失效 | 用 `pendingRef` 区分"我刚写入的"和"用户改的"，否则写入会立刻清栈 |
| 7 | 增强后自动弹 diff 卡 | 标新增/删除/处数/净增字数，Escape 关闭，卡上可直接撤销 |
| 8 | 失败 → 按钮短暂变红，hover 显示中文原因，再点重试 | 错误文案按 code 本地化 |
| 9 | 请求期间变更草稿 | 丢弃结果 + `error` 态提示（v1 采用 wjf1 策略；v2 可选 npm 版的 `stale` 警告 + 允许回填） |

### 4.3 视觉约束

- 按钮尺寸与工具行现有图标一致，继承 `currentColor`，**不硬编码品牌色**。
- diff 卡：锚定 `cardOf(composer)` **而非按钮**（按钮会随工具行重排）；宽 `min(560px, 100vw - 24px)`；`maxHeight` 按可用空间算，`resize` 时重算；`createPortal` 到 `body`。
- diff 配色不得只靠颜色区分：新增用继承正文色 + 绿底 + 底线，删除用红字 + 删除线，另加「新增 / 删除」图例。（对标 README 中 WCAG AA 的教训）
- **不改 card 的 `marginBottom`**——那是状态栏在用的让位边距，两者会打架。本项目只用绝对定位浮层，贴在卡片**内部**右侧。

---

## 5. 技术架构

### 5.1 分层

```
┌────────────────── 渲染进程（注入 overlay-prompt-enhance.js） ──────────────────┐
│                                                                              │
│  composer 定位（复用 deepFind/cardOf）                                        │
│      ↓                                                                       │
│  读草稿  composer.innerText                                                  │
│  写草稿  selectAllChildren → execCommand('insertText') [三级降级]             │
│      ↓                                                                       │
│  ✨ 按钮浮层（absolute，跟随卡片矩形，逐帧校正）                              │
│  撤销栈（8 层）· diff 卡（token 级 LCS）· 错误提示                           │
│      ↓  IPC（ipcMain / executeJavaScript 双向）                              │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │
┌────────────────── 主进程（inject-main.cjs 扩展） ─────────────────────────────┐
│                                                                              │
│  provider 路由解析  读 ~/.zcode/v2/provider_config.json                       │
│      ↓                                                                      │
│  enhancer-core: 三闸门（限流/并发/熔断）→ 超时 AbortController                │
│      ↓                                                                      │
│  HTTPS 客户端  POST {baseUrl}/messages  SSE 流式                            │
│      ↓                                                                      │
│  输出清洗（围栏/前缀/引号/空行）→ 错误码归一化                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

**为什么 LLM 调用放在主进程**：apiKey 在 `provider_config.json` 里；渲染进程注入的脚本同源可被 DevTools 检查，且页面内任何第三方脚本理论上能读到 `window` 上挂的东西。主进程持 key、只回文本，是 dsh-prompt-enhance 两版共同的安全结论。

### 5.2 提示词设计（复用策略）

两份实现的 prompt 都在本项目 `APPENDIX.md` 里全文保留。取舍：

| 维度 | wjf1 版 | npm 版（rongxingda） | 本方案 |
|---|---|---|---|
| 策略 | WorkBuddy 逐字复刻，轻量改写 | 自研六段式（role/context/steps/format/acceptance/boundary） | **npm 六段为骨架** |
| 语言一致性 | system + user 双写，含 BAD/GOOD 对照 | 一句 hard rule | **两者合并**：六段 + BAD/GOOD 示例 |
| 防臆造 | "Do NOT suggest specific technologies" | 未知细节用 `(待补充：…)` 占位 | **用占位符**，可执行性更强 |
| 注入防护 | 无 | `<raw_prompt>` 定界 + 标签转义 | **采用** |
| 上下文 | 无 | `<conversation_context>` + 预算从新到旧 | **采用**（P2 期） |
| 长度 | ~800 字符 | 1x–3x 原文 | 取 1x–3x，上限 3000 字符 |

### 5.3 输出清洗（合并两版最严的部分）

```js
function cleanEnhancedText(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return '';
  // 1) 围栏：只有恰好一对 ``` 才剥（正文含多个代码块时原样保留）
  const marks = (t.match(/```/g) || []).length;
  if (t.startsWith('```') && /```\s*$/.test(t) && marks === 2) {
    t = t.includes('\n') ? t.slice(t.indexOf('\n') + 1).replace(/```\s*$/, '').trim()
                         : t.slice(3, -3).trim();
  }
  // 2) 前缀：仅当独占一行时剥
  t = t.replace(/^(?:Enhanced prompt|增强后的提示词|增强提示词|重写后的提示词)\s*[:：]\s*\n?/i, '').trim();
  // 3) 引号：只认同类开闭，且正文含任何引号就不剥
  const PAIRS = [['"','"'],['“','”'],["'","'"],['‘','’']];
  const p = PAIRS.find(([o, c]) => t.length > o.length + c.length && t.startsWith(o) && t.endsWith(c));
  if (p) {
    const inner = t.slice(p[0].length, t.length - p[1].length).trim();
    if (inner && !/["“”'‘’]/u.test(inner)) t = inner;
  }
  // 4) 折叠 3+ 空行
  return t.replace(/\n{3,}/g, '\n\n').trim();
}
```

### 5.4 路由解析（provider / model）

ZCode 的 provider 配置是**单一事实来源**：`~/.zcode/v2/provider_config.json` →
`config.providerConfigRules.providerRules[]`，每条含 `providerId` / `config.access.apiKey` / `config.api.{type,baseUrl}` / `config.personalModelIds`。

解析优先级（对标 npm 版 `resolveRoute`）：
1. 用户在插件设置面板显式指定的 `provider/model`（若存在且鉴权类型为 `api-key`）；
2. 配置里的第一条可用 provider 的首个 model（当前环境 = `new-provider-4 / cn:deepseek-v4.1-flash`）；
3. 无可用配置 → 按钮置灰，`title` 显示 `unsupported` 文案。

⚠️ **渲染进程读不到「用户当前选中的模型」**（那是 React 内部 state）。v1 不做跟随，用配置默认；v2 可选方案：在设置面板里让用户选一个"增强专用模型"，或从 composer 工具行的可见文本里正则提取（脆弱，不推荐）。

模型 ID 白名单（防请求体操控上游路由）：`/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/`。`provider` 与 `model` **必须同时合法**才采用，任一不合法则**整组回落默认**。

### 5.5 调用参数

```js
{
  model,                       // 见 §5.4
  max_tokens: 2048,
  temperature: 0.3,            // 改写任务，不需要创造力
  system: SYSTEM_PROMPT,       // Anthropic 风格走顶层 system，不进 messages
  messages: [{ role: 'user', content: frameUserPrompt(draft, context) }],
  stream: true                 // P2 起
}
```

- 超时 **60s**（`AbortController` + 迭代竞速，`Promise.race([iterator.next(), aborted])`）。
- 超时后必须 `iterator.return()`——否则上游流仍活着、继续产生 token、照旧计费。
- 失败判定：`finish_reason === 'max_tokens'` / 响应含 `tool_use` block / 清洗后为空，三者都算失败。
- 错误码归一化：`AUTH` / `RATE_LIMIT` / `QUOTA` / `EMPTY` / `CONTEXT_WINDOW` / `MAX_TOKENS` / `TOOL_CALL` / `TIMEOUT` / `INTERNAL`，文案表放渲染端本地化（中文主文案不能从宿主泄漏到英文 UI）。

### 5.6 三闸门（P3）

按 npm 版 0.3.2 的顺序，**顺序是刻意设计的**：

1. **失败熔断**：连续 3 次失败 → 冷却 30s，期间 429。动机：滑动窗口只统计成功调用，若不熔断，对持续失败的模型重试次数只受并发上限约束。
2. **滑动窗口限流**：60s / 10 次，**只统计成功的调用**。动机：统计"尝试"会让一串超时把用户额度烧光，正在模型恢复时把用户锁死。拒绝时带精确 `Retry-After`。
3. **并发上限**：2，超额 429 且**不带** `Retry-After`（槽位释放时间不可预测）。

调用方主动 abort **不计入**失败。

---

## 6. 核心模块设计

### 6.1 目录结构

```
F:\AI\Zcode\zcode-prompt-enhance\
├── DESIGN.md                    # 本文件
├── APPENDIX.md                  # 两份参考实现的关键源码摘录（prompt 全文 / 清洗 / diff / 限流）
├── HANDOFF.md                   # 接力开发文档（按规范维护）
├── README.md / README.en.md     # 中英双语（发布前补齐）
├── CHANGELOG.md
├── package.json
├── config.example.json          # { provider, model, maxInputChars, shortcut, ... }
├── config.json                  # 本地实际配置（gitignore）
├── inject-main.cjs              # 主进程 loader：注入、IPC、provider 解析、调模型
├── overlay-prompt-enhance.js    # 渲染端：按钮、草稿读写、撤销栈、diff
├── core/
│   ├── prompt.mjs               # SYSTEM_PROMPT + frameUserPrompt + cleanEnhancedText
│   ├── provider.mjs             # provider_config.json 解析 + 路由选择
│   ├── enhancer.mjs             # 调用 + 超时 + 流式 + 错误码
│   ├── gates.mjs                # 限流 / 并发 / 熔断
│   ├── diff.mjs                 # token 级 LCS + 统计
│   └── context.mjs              # 上下文装配（P2）
├── repatch_asar.mjs             # 解包→追加 __ZPE_PATCH__ 行→重打包→替换
├── uninstall.mjs                # 移除注入行（幂等）
└── test/
    ├── prompt.test.mjs
    ├── diff.test.mjs
    ├── gates.test.mjs
    ├── provider.test.mjs
    └── clean.test.mjs
```

### 6.2 asar 注入层

与 token 状态栏项目**互不干扰**的三个设计：

| 冲突点 | 状态栏项目 | 本项目 | 结论 |
|---|---|---|---|
| patch marker | `__ZUSAGE_PATCH__` | `__ZPE_PATCH__` | 各自幂等守卫，互不覆盖 |
| 注入方式 | `out/main/index.js` 尾行 append | 同 | `repatch` 是"解包当前 asar→append→repack"，保留对方已有行 |
| composer 卡片边距 | 读写 `marginBottom` 让位 | **完全不碰** | 只用内部绝对定位浮层 |
| 浮层 z-index | 条贴卡片上方 | 按钮贴卡片内右下 | 不重叠 |

`repatch_asar.mjs` 照抄状态栏项目的结构（解包 → 备份 `app.asar.bak-<yyyymmdd>` 保留 3 份 → 幂等 append → `--unpack "**/*.{dll,exe,node}"` 重打包 → 替换），改写 `MARKER` 和 loader 路径。**必须有 `--dry-run`**。

### 6.3 按钮浮层挂载

不插入 React 管理的 DOM（重渲染会被擦掉），用 `position: absolute` 浮层跟着卡片矩形走：

```js
// 1. 找到 composer 卡片（复用 cardOf 逻辑）
const card = cardOf(composer);
// 2. 按钮浮层挂在 body，绝对定位
btn.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:auto;/* 其余继承工具行图标尺寸 */';
// 3. 逐帧对齐到卡片右下工具行位置（每帧只做 getBoundingClientRect → 设 left/top）
function follow() {
  if (!card.isConnected) return remount();
  const r = card.getBoundingClientRect();
  // 目标：卡片右下角，左移约「发送按钮宽度 + 模型选择器宽度」
  btn.style.left = `${r.right - ANCHOR_FROM_RIGHT}px`;
  btn.style.top  = `${r.bottom - TOOLBAR_OFFSET}px`;
  requestAnimationFrame(follow);
}
```

**必须处理的坑（全部来自状态栏项目的实战）**：
- 可见性：`elementFromPoint` 命中测试，防止设置页/模态盖住时按钮仍浮在上面。
- 穿透假象：滚动锁定时应用层 `pointer-events:none`，`elementFromPoint` 会穿到底 → 命中 `body`/`html` 即视为被遮挡。
- 模态排除：`closest('[role="dialog"]')` 内的 contenteditable 不是聊天输入框。
- 自己的浮层要豁免遮挡判定，否则会进"隐藏→复显→再隐藏"循环。

### 6.4 草稿读写（**最高风险项**）

**读**：`composer.innerText`。Lexical 会用 `<p>`/`<br>` 渲染段落，`innerText` 能拿到近似文本，但需归一化连续空行。

**写**（三级降级，P0 必须逐一验证）：

```js
// L1：原生命令（浏览器会触发 beforeinput，Lexical 通常能正确接收）
function writeDraftL1(el, text) {
  el.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(el);
  return document.execCommand('insertText', false, text);
}

// L2：合成 beforeinput（L1 返回 false 或内容不符时）
function writeDraftL2(el, text) {
  el.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(el);
  sel.deleteFromDocument();
  el.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertText', data: text, bubbles: true, cancelable: true,
  }));
}

// L3：兜底——写入剪贴板 + 提示条「已复制增强结果，请手动粘贴（Ctrl+V）」
//     绝不静默失败：宁可让用户多按一次 Ctrl+V，也不能吞掉结果
```

写后必须**回读校验**：`normalize(readDraft()) === normalize(expected)`，不一致就降级。这条校验同时是自动化测试的断言点。

### 6.5 diff（token 级 LCS，无第三方依赖）

```js
// 切分：连续空白整体、单个汉字、拉丁词/数字、其它单字符
const tokenize = (s) => String(s).match(/\s+|[\u3400-\u9fff]|[A-Za-z0-9_]+|[^\s]/g) || [];
const CAP = 800;  // 超过就退化为整段替换，避免卡住输入框
// 反向填表 LCS + 回溯，用 Uint16Array 压内存（CAP=800 时 16 位足够）
```

中文逐字 → 视觉接近字符级高亮；英文词级。超过 800 token 退化为 `[{del: 全文}, {ins: 全文}]`。
渲染前按 `\n` 切行（`segmentsToLines`），避免长提示词变成一整块。
统计行：`N 处改动 · A 字新增 / R 字替换 · 净 ±D 字`。

### 6.6 撤销栈

```js
stack = [{ before, after }]   // 上限 8，slice(-8)
// 写入前记录 pendingRef = after，防止自己的写入被 useEffect 判成"用户编辑"而清栈
// 用户编辑检测：draft !== top.after && draft !== pendingRef  → 整栈清空 + 关 diff
```

---

## 7. 分期计划

| 期 | 内容 | 交付物 | 预估 |
|---|---|---|---|
| **P0** | 打掉两个最高风险：① `execCommand` 能否写入 Lexical（含 L1/L2/L3 三级验证）② asar 注入 + 浮层能否稳定挂到工具行。同时打通"点击 → 调模型 → 拿到文本 → 回填"最小闭环 | `inject-main.cjs`（简版）+ `overlay-*.js`（仅按钮+一次调用）+ `repatch_asar.mjs` + 手工验收记录 | 1 天 |
| **P1** | 完整状态机：置灰/取消/二次读校验/失败重试/8 层撤销 + diff 卡 | 完整 `overlay` + `core/diff.mjs` + 单测 | 1.5 天 |
| **P2** | 上下文感知（`<conversation_context>` + 预算从新到旧 + code point 计数）+ SSE 流式预览 + 显示态归一化 | `core/context.mjs` + 流式 UI | 1.5 天 |
| **P3** | 设置面板（provider/model/maxInputChars/快捷键）+ 三闸门 + 升级后版本检测提示 + 一键卸载 | 面板 + `core/gates.mjs` + `uninstall.mjs` | 1.5 天 |
| **P4** | 兜底形态：skill + `/enhance` 命令（增强结果落对话，供 E 失效时使用）+ 文档四件套 + 发布 | `skills/` + `commands/` + README×2/CHANGELOG/HANDOFF | 1 天 |

**总计约 6.5 个工作日。** P0 结束即可判断整条路是否成立——若不成立，退回 C（MCP App 侧栏）并把交互预期降级为「侧栏改写 + 确认发送」。

---

## 8. 验收标准

### 8.1 功能验收（P0/P1 必过）

- [ ] 空草稿：按钮置灰且 `aria-label` 可读（不是裸图标）
- [ ] 有草稿：点击后 3s 内返回，草稿被替换，原文进撤销栈
- [ ] busy 时再点：请求被 abort，草稿**逐字节不变**
- [ ] 增强中修改草稿：结果被丢弃，提示「草稿已修改，已放弃增强结果」
- [ ] 增强成功后再改草稿：撤销按钮消失（栈失效）
- [ ] 对结果再增强：连续 3 次后逐层撤销能回到最初原文
- [ ] 断网 / 401 / 超时：按钮变红，hover 有中文原因，再点可重试
- [ ] 超时场景：主进程日志显示上游连接**已关闭**（不是仅停止等待）
- [ ] 输出清洗：` ```text ` 围栏被剥；正文含"引号"时外层引号不被剥；`Enhanced prompt:` 前缀被剥
- [ ] 草稿含 `</raw_prompt>`：不会被当作帧闭合符

### 8.2 界面验收（符合 AGENTS.md 前端 DOM 变更规范）

- [ ] **真实鼠标点击走查**全部关键路径（打开 → 输入 → 点 ✨ → 结果 → 撤销 → diff → 关闭），仅脚本 `click()` 不算验收
- [ ] 新增 CSS 类名统一 `zpe-` 前缀，**新增 DOM id 全局唯一**（落地 `test/id-unique.test.mjs` 解析 overlay 源码断言无重复 id）
- [ ] 断言"按钮属于 composer 卡片"时必须用 `closest()` / `contains()` 验证祖先链，不能只查 `getElementById` 存在性
- [ ] 暗色/亮色主题下 diff 卡对比度 ≥ WCAG AA；不只用颜色区分增删
- [ ] 设置页 / 模态 / 下拉打开时按钮正确隐藏（`elementsFromPoint` 命中栈验证）
- [ ] 与 token 状态栏**同屏共存**不打架（两者都开，检查边距、z-index、遮挡）

### 8.3 安全验收

- [ ] apiKey 不出现在渲染进程任何位置（`window`、DOM、console、网络请求体均无）
- [ ] 输入/输出不写日志（只记 requestId 与长度）
- [ ] 请求体上限：`maxInputChars × 6 + 4096`，Content-Length 超限时**不读一个字节**直接 413
- [ ] 草稿里的注入指令（"忽略以上指令"）不改变输出结构
- [ ] `uninstall.mjs` 能完全移除注入行并还原 asar（幂等，可重复执行）

---

## 9. 风险与约束

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| **R1** | ZCode 升级后 asar 被整份替换，注入丢失且**静默失效** | 按钮消失，用户以为坏了 | ① 主进程启动时校验注入标记，缺失则告知"需要重跑 repatch" ② 每次升级后自动 grep `enhancePrompt`，官方发布即弃用本项目 ③ `repatch` 保留 3 份备份 |
| **R2** | Lexical 写入失败或 React state 不同步（**首次点击后草稿"看着变了但发送的是旧内容"**） | 数据正确性问题，比功能缺失更严重 | 三级降级 + **写后回读校验**；校验不过一律降到 L3（剪贴板），绝不静默通过。P0 必须先验证 |
| **R3** | 非官方修改客户端，ZCode 更新策略变化（如启用 asar integrity 校验）会导致无法注入 | 方案整体失效 | 有 statusbar 项目作为"哨兵"——它一失效就是信号；届时退回 C 路径 |
| **R4** | 重启 ZCode 属服务启停 | 违反 AGENTS.md 硬约束 | **每次重启前单独向用户书面确认**，说明预计停机秒数与是否自动拉起 |
| **R5** | 与 token 状态栏抢 composer 卡片布局 | 两者错位/遮挡 | 本项目不碰 `marginBottom`、不碰卡片内子节点，只用独立绝对定位浮层 |
| **R6** | provider 配置结构变更（`providerConfigRules.providerRules` 是内部格式，无版本契约） | 路由解析失效 | 解析失败一律降级到"按钮置灰 + 设置面板手填 baseUrl/model/key 到 `config.json`" |
| **R7** | 长草稿（20k 字符）触发上游 400 / 超时 | 体验中断 | 输入上限 12000 字符（对标 npm 版），超限**拒绝不截断**，提示明确字数 |

---

## 10. 需要用户决策的事项

1. **是否接受"修改客户端 asar + 每次升级重打"这个代价**去换取真正的"按钮 + 就地回填"。若否，则只能选 C（侧栏面板 + 确认发送），交互降级明显。
2. **默认增强模型**用 `new-provider-4 / cn:deepseek-v4.1-flash`（已验证可用）还是另配？
3. 是否同时交付 P4 的 `/enhance` 兜底命令（成本约 0.5 天，可在 E 失效期间顶上）。

---

## 附录 A：关键证据索引

| 结论 | 证据位置 |
|---|---|
| ZCode 插件 manifest 必需字段 / 模板变量 | `~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/0.3.0/skills/diagnosing-plugins/SKILL.md` |
| hook 仅 7 个事件 | 同上目录 `diagnosing-hooks/SKILL.md:26` |
| `UserPromptSubmit` 输出 schema 无 `updatedPrompt` | `E:\ZCode\resources\glm\zcode.cjs` zod 定义（`V.object({additionalContext...,hookEventName:V.literal(Tl.UserPromptSubmit)}`） |
| 普通 MCP server 无 sampling 能力 | `zcode.cjs` MCP capabilities 构造（仅 `extensions:{[Zns]:...}`，无 `sampling`） |
| MCP App 有 `sampling/createMessage` | `app.asar` `pluginUiSamplingService` / `sampleModel`（`querySource="mcp_app_sampling"`） |
| `ui/message` = 发送而非回填 | `app.asar` `onSendFollowUpMessage` → `sendFollowUp` → `sendText` |
| `ui.surfaces` 只能是 `session` | `app.asar` zod：`availability: e.literal("session")` |
| composer 是 Lexical | `~/.zcode/zcode-token-usage-statusbar/diag-0.json` |
| 注入先例与实现 | `~/.zcode/zcode-token-usage-statusbar/{repatch_asar.mjs,inject-main.cjs,overlay.js}` |
| provider 可用性（实测 200） | `~/.zcode/v2/provider_config.json` → `new-provider-4` |
| 官方市场无同类插件 | `~/.zcode/cli/plugins/marketplaces/zcode-plugins-official/marketplace.json`（66 条，关键词全无命中） |

## 附录 B：参考实现

两份提示词模板全文、清洗与 diff / 限流源码摘录见同目录 **`APPENDIX.md`**。
