# 变更日志

本项目的所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.2] - 2026-10-30

**ZCode 3.17.1 重新部署 + 工具链路径修复。运行时行为零变更，0.3.1 的注入逻辑原样重新部署。**

### 修复

- `tools/check-asar-loadable.mjs` 硬编码旧安装路径 `F:/software/Zcode`（ZCode 迁至
  `E:\ZCode` 后该工具必挂）：改为与 `repatch_asar.mjs` 相同的候选探测
  （`--asar` 参数 / `ZPE_ASAR` 环境变量 / `LOCALAPPDATA` / `E:/ZCode`）。
- 同工具对「恰好 2 行 loader」的硬性断言放宽为「至少 1 行」：状态栏项目
  （`__ZUSAGE_PATCH__`）注入随 ZCode 升级丢失时只有 1 行是真实状态，
  如实报告而非误报本项目失败（2 行 = 状态栏项目也在）。
- `repatch_asar.mjs` / `uninstall.mjs`：删除 `F:/software/Zcode` 死候选路径。
- `test/trust.test.mjs` 样本 URL 与 README（中英）、HANDOFF 查证命令示例中的
  旧路径同步更新为 `E:/ZCode`。

### 部署

- ZCode 于 2026-10-29 升级 3.17.1，asar 整份替换导致注入丢失；2026-10-30 已重新注入
  并核验（`PATCHED`、`check-asar-loadable` ALL PASS）。注入行仅本项目 1 行，
  状态栏项目需在其仓库自行重新注入。

## [0.3.1] - 2026-10-26

**修复 0.3.0 的注入回归：主窗口在 `web-contents-created` 时还没有 URL，被可信判定当场拒绝，按钮从未出现。**

### 修复

- `inject-main.cjs` 的 `web-contents-created` 与初始窗口遍历两处入口恢复按窗口类型
  （`isMainWindow`）过滤。可信判定（URL 校验）保留在 `inject()` 内 —— 那时
  `did-finish-load` 已触发、URL 已就绪。
  - 症状：桥接服务正常监听（loader 已加载），浮层却从未进入任何窗口。
  - 根因：创建事件触发时 `wc.getURL()` 返回空串，`trust.check("")` 恒为 false，
    窗口在挂上注入钩子之前就被 return。
  - 安全性不变：远程页面、webview 依旧被拒（`tools/inject-gate-selftest.mjs` 覆盖）。
- 新增 `tools/inject-gate-selftest.mjs`：stub electron 完整模拟「窗口创建 → 加载完成 →
  注入」时序。旧代码在该测试下恰好失败两条回归锚点（负对照已实测验证）。

### 说明

- asar 无需重打：注入行只负责 import 外部 loader；本次只改部署路径上的
  loader / overlay 文件，重启主进程后生效（overlay 走 mtime 热更新，无需重启即可热注入）。

## [0.3.0] - 2026-10-26

**加固与适配版**：修掉「安全退路反而压住发送按钮」的定位炸弹，收窄桥令牌的注入面，
把三类静默失败（定位劣化、配置格式变更、编辑器不兼容）变成可观测状态。
无新增运行时依赖，118 → 140 项测试。

### 修复

- **✨ 落点会压住原生按钮（P0，真机可复现）**
  - `anchorFor` 的 fallback 退路原为「卡片右下角内缩 40/34」。ZCode 3.16.3 的真实矩形下
    它落在 `1154,679`，而发送按钮占 `1153-1181 × 673-701` —— 直接相交。
    也就是说：工具行识别失败（UI 改版）时，本该"安全"的退路恰好压住发送。
  - 现在三个候选落点统一过 `settle()`：与任何原生按钮矩形相交时，沿同一行左右步进
    （8px 步长、最多各 24 步）找空隙；找不到空隙则返回 `hidden`，**宁可让按钮消失也不遮挡原生 UI**。
  - 无按钮场景（`row.length === 0`）保持原行为，直接落右下角。
  - 重叠判定统一用 `top+height` / `left+width` 推导右下角 —— 测试 mock 的矩形没有
    `bottom` 字段，直接读会得到 `undefined`，比较恒为 false，形成"测试假通过"。

- **卡片容器误判导致三处锚点漂移（P0）**
  - `cardOf` 原先只要遇到"有边框或非透明背景"的祖先就当卡片。3.16.2 起输入框内部新增了
    带背景的模型切换条，那个内层容器被当成卡片，按钮 / diff 卡 / toast 一起漂。
  - 新增 `plausibleCard` 双重校验：① 宽度 ≥ composer 宽度的 90%；② 下半部真有工具行
    （≥2 颗 16-44px 的可点按钮）。不满足则继续上溯。
  - 兜底 `return last` 保留：任何情况下都不返回 `null`，否则 `place()` 直接崩、按钮永久消失。

- **不可恢复的凭据错误被标成"可重试"（P0）**
  - 桥层原先硬编码 `retryable = code !== "auth" && code !== "quota"`，但 core 的错误码表里
    `invalid-credential` 是 `retryable: false`。结果是浮层给凭据错误显示"重试"按钮，
    用户点了必然再失败并再烧一次请求额度。
  - 改为查 `describeError(code).retryable`；core 未就绪时保守返回 false。

- **超时回落导致双份计费（P1）**
  - 回落白名单原先包含 `timeout`。超时时上游往往已产出并计费了大量 token，
    整包重发 = 一次点击烧双份额度。
  - `enhanceDraft` 现在记录 `hadFirstChunk`；桥层只在 `code === "timeout" && hadFirstChunk === false`
    （一个 token 都没吐）时才回落。
  - 注意标记补在 `EnhanceError` 分支而不只是 `AbortError` 分支：超时实际由 `nextOrAbort`
    竞速抛出 `EnhanceError("timeout")`，只挂在后者会漏掉最常见的超时路径。

- **浅色用户系统性看到暗色卡片（P2）**
  - `isDark()` 原先把透明背景 `rgba(0,0,0,0)` 当成黑色。浅色主题下 body 常是 transparent，
    于是稳定误判成暗色。
  - 改为依次探测 `:root` → `body`，跳过 alpha=0 的候选；再兜底读 `color-scheme`；
    最后跟随 `prefers-color-scheme`。toast 也改用同一套 `--zpe-bg` / `--zpe-fg` 变量。

- **error 态不随草稿修改复位**：草稿被改后，`draft-changed` / `too-long` / `empty`
  三类错误复位为 idle（改草稿能好的才复位，鉴权/额度类不复位）。

- **Esc 吞掉宿主事件**：原实现用 capture + `stopPropagation`，宿主 App 自己的 Esc 处理
  永远收不到。改为**仅当焦点在 diff 卡内**才拦截并关闭，且不再 `stopPropagation`。

### 新增

- **`core/trust.mjs`：窗口 URL 可信判定（P0 安全）**
  - 背景：`isMainWindow` 只判 `wc.getType() === "window"`，不校验窗口加载的 URL；
    而桥 token 是进程生命周期常量、永不过期。任一 window 型窗口若加载远程内容，
    该页面即可读到 `window.__ZPE_BOOT__.token`，以用户 apiKey 代发请求燃烧额度。
  - 默认只信任本地打包协议（`file:` / `app:` / `chrome-extension:` / `devtools:`），
    远程页面必须显式写进 `config.json` 的 `allowed_window_hosts` 才注入。
  - trust 模块尚未加载完成时，退回"只允许本地协议"的安全默认（不是放行全部）。
  - 新增 `test/trust.test.mjs`（7 项）。

- **桥侧 Host 校验（DNS rebinding 防护）**：在 token 校验之前校验 `Host` 头必须是
  `127.0.0.1:<port>` 或 `localhost:<port>`。攻击者域名可解析到 127.0.0.1（来源 IP 也是本机），
  但 Host 头会是其域名，这一层能挡住。

- **`config.json` 新字段 `allowed_window_hosts`**（默认 `[]` = 只信任本地页面）。

- **provider 配置版本探测与三态上报（P1）**
  - 新增 `candidateConfigPaths()`（v2 → v3 → cli → v1）、`detectConfigShape()`
    （`anthropic-v2` / `unknown` / `missing`）、`findConfig()`。
  - `GET /health` 增加 `configPath` 与 `configShape`；无路由时的 503 detail 把
    "文件不存在 / 格式不认 / 没有可用 provider"三态分开，不再统一一句"unsupported"。

- **Lexical 版本不兼容探针（P1）**：写入失败或回读不一致时先跑最小 state 探针，
  区分"编辑器版本不兼容"（新错误码 `lexical-incompatible`，中文文案"编辑器版本不兼容，请更新插件"）
  与业务错误。

- **定位降级显式化（P0 可观测性）**
  - `place()` 检测到 `via !== "cluster"` 持续超过 5s 且未提示过 → `showToast("按钮位置可能不准（界面布局已变化）")`，会话内一次。
  - `place()` 的 catch 首次触发时 `console.warn("[zpe] place error:", msg)`（原先只写 state，纯黑盒）。
  - `__zpeState()` 新增 `anchorDegraded` / `anchorVia`；恢复到 cluster 路径时复位。

- **diff 卡焦点管理**：打开后焦点进卡片关闭按钮，关闭后还焦到 ⇄；
  `diffBtn` 维护 `aria-expanded`。busy 进度同步写入 `aria-label`（原先只有 `title`，读屏读不到）。
- **撤销栈深度可见**：↺ 的 `title` / `aria-label` 动态为「恢复原文（还可 N 步）」；
  整栈被清空时提示「撤销历史已清空」。

### 性能

- **`place()` 每帧开销收敛（P1）**：卡片矩形签名未变时直接复用上一帧落点，
  不再每帧 `querySelectorAll` + 全量 `getBoundingClientRect`。
  400ms 兜底定时器改为 `place(true)` 强制重算，防止"卡片矩形不变但工具行按钮增减"漏检。
  实测：420ms 窗口内工具行扫描从约 26 次降到 2 次。
- **草稿轮询短路（P1）**：`checkDraftChange` 先用 `innerText` 廉价指纹判断"没变"就返回，
  避免每 300ms 做一次 `toJSON` + 整树递归。`innerText` 只用于短路，绝不用于判等/写入校验。
  `rediscover` 与所有 `lastDraft` 赋值点统一走 `syncDraftBaseline`，同步更新指纹。

### 测试

- anchor 测试扩容到 15 项：新增「落点不与任何原生按钮相交（含发送）」
  「右侧簇占满时要么隐藏要么不压按钮」「全行铺满时必须 hidden」三条回归锚点，
  以及 3 项 `cardOf` 容器校验用例。
  - 同时修掉一个测试盲区：mock 的 `querySelectorAll` 原先只认 `"button"`，
    而 `findModelButton` 用的是 `"button, [role='button']"` —— **model 路径在测试中恒不可达**。
- 新增 `test/trust.test.mjs`（7 项）、provider 形状探测 6 项、enhancer `hadFirstChunk` 2 项。
- `tools/sim-overlay.mjs` 扩容：
  - `FakeNode.style` 现在会像真实 DOM 一样把 `cssText` 展开成属性。
    此前 `style.display` 恒为空串，所有 `display !== "none"` 判断都假绿
    （diff 卡"可见"断言一直没真正生效）。
  - 补 `querySelector` 实现：`positionDiff` 原每帧抛 `TypeError`，
    错误被 `state.placeError` 静默吞掉，diff 卡定位从未被验证过。
  - 新增 T08 缓存有效性、T11 主题/无障碍/Esc 冒泡断言。
- 总计 **140 项**，`npm test` 全绿；`preflight` ALL PASS；`bridge-selftest` 全过（含真实模型调用）；
  `sim-overlay` 全过。

### 已知取舍

- `allowed_window_hosts` 默认空。若某次 ZCode 改版把主窗口改为远程加载（当前实测是
  `loadFile(.../renderer/index.html)`，即 `file:`），按钮会消失。此时把实际主机名填进该字段即可，
  **不要**为了省事默认放行所有 http/https。
- `checkDraftChange` 的 innerText 短路对纯格式变更（加粗/斜体）不敏感；本插件只消费纯文本，无影响。

## [0.2.0] - 2026-10-26

**增强用的模型改为实时跟随当前会话选中的模型**，跟随失败自动回落到默认模型。

### 新增

- **实时跟随会话模型**
  - 点 ✨ 时读取工具行模型按钮的标签文本，交给主进程反查可用路由；
    命中即用同一个模型做增强，与对话中的模型保持一致。
  - 反查不解析模型名，改用「已知模型 id 是否被标签包含」的最长匹配 ——
    模型 id 自身可能含 `/`（`meta/muse-spark-1.3`、`deepseek/deepseek-v4.1-flash`），
    按分隔符切分必然出错。
  - 匹配前做边界检查（模型 id 前后不能紧邻字母/数字/`_`/`-`/`.`），
    防止 `gpt-6` 命中 `gpt-6-astra` 的内部。
  - 等长且指向不同路由 → 判为歧义，安静回落，不做猜测。

- **跟随失败自动回落**
  - 会话模型所属 provider 额度耗尽、鉴权失败、网络不可达或超时 → 自动用默认路由再试一次（仅一次）。
  - 回落时浮层提示「会话模型不可用，已改用 <模型>」，不静默换模型。
  - 用户主动取消不触发回落。

- **模型可见性**
  - 增强成功后浮层提示实际使用的模型与来源（跟随 / 默认 / 回落）。
  - `__zpeState()` 暴露 `sessionModelLabel` 与 `usedRoute`，便于验收断言。

### 变更

- `resolveRoute` 的优先级调整为：跟随会话 → 显式 provider → 显式 model → 默认第一条。
  传入空标签时的行为与 0.1.0 完全一致。
- 路由缓存键加入会话模型标签与 `config.json` 的 mtime，切换模型后立即生效。

### 测试

- 新增 13 项跟随算法测试（真机 aria 样本、含 `/` 的模型 id、前缀碰撞、中文尾缀、等长歧义、
  非字符串输入、无凭据 provider 不被选中、回落链）。
- 新增真实链路验证：跟随到可用模型正常工作；跟随到额度耗尽的模型会正确回落并成功返回。
- 总计 118 项，`npm test` 全绿。

## [0.1.0] - 2026-10-26

首个可用版本。实现「输入框旁 ✨ 一键增强提示词」，采用 asar 注入方案。

### 新增

- **渲染端浮层**（`overlay-prompt-enhance.js`）
  - ✨ 按钮浮在聊天输入框卡片工具行内、模型选择器左侧，与原生图标同尺寸（28×28），继承 `currentColor`。
  - 完整状态机：`idle` / `busy`（转圈，可点击取消）/ `error`（变红，hover 显示中文原因，可重试）。
  - 撤销栈 8 层，逐层回退到最初原文。
  - token 级 LCS diff 卡：标注新增/删除/处数/净增字数，Escape 关闭，卡上可直接恢复原文。
  - 增删不只靠颜色区分：新增用绿底 + 下划线，删除用红字 + 删除线，另附文字图例。
  - 空草稿置灰、超长草稿拦截（12000 字上限，拒绝而非截断）。

- **主进程注入层**（`inject-main.cjs`）
  - 向每个窗口注入浮层，支持按 mtime 热更新（改文件免重启）。
  - 本地 HTTP 桥：仅监听 `127.0.0.1` 随机端口，配随机 token 双重限制，只接受本机回环请求。
  - 流式增强回推（NDJSON），页面内的进度实时反映到按钮提示。
  - provider 路由解析：读 `~/.zcode/v2/provider_config.json`，按 `providerOrder` 选第一条可用的 `anthropic-messages` 路由；解析失败降级为按钮置灰，不崩。

- **核心模块**（`core/`，零运行时依赖）
  - `prompt.mjs`：六段式 system prompt + BAD/GOOD 语言示例 + `<raw_prompt>` 定界转义 + 输出清洗。
  - `provider.mjs`：路由解析，`provider`/`model` 双白名单校验，任一非法整组回落默认。
  - `enhancer.mjs`：Anthropic Messages SSE 客户端，竞速迭代超时，超时/取消时显式关闭上游流。
  - `diff.mjs`：token 级 LCS，中文逐字、英文词级，超 800 token 退化为整段替换。
  - `gates.mjs`：失败熔断（连续 3 次 → 冷却 30s）→ 滑动窗口限流（60s/10 次，只统计成功）→ 并发上限（2）。

- **运维脚本**
  - `repatch_asar.mjs`：解包当前 asar → 追加 `__ZPE_PATCH__` 注入行 → 重打包 → 替换，保留 3 份备份，支持 `--dry-run` / `--check`。
  - `uninstall.mjs`：移除注入行还原客户端，幂等，不影响状态栏项目的注入行。
  - `tools/` 下 8 个校验脚本：注入前体检、注入后完整性、asar 可加载性、桥接自测、模型链路探针等。

- **测试**：89 项，`node --test "test/*.test.mjs"` 全绿。
  - 提示词/清洗、diff 自洽性、provider 白名单、SSE 解析与超时、三闸门顺序。
  - overlay 静态断言：DOM id 全局唯一、类名统一前缀、不碰 `marginBottom`、不用 `execCommand`、apiKey 不泄漏。
  - 页内 diff 副本与 `core/diff.mjs` 逐字节一致性双向校验。

### 关键技术决策

- **草稿写入改用 Lexical 公开 API，否决 `execCommand` 方案。**
  实测：`document.execCommand('insertText')` 能写入空的 Lexical 编辑器，但所有基于 DOM selection
  的删除手段（`delete` / `deleteFromDocument` / `range.deleteContents`）全部无效 —— Lexical 的
  selection 与 document selection 不同步，用它写入的内容无法再被程序化清除，是单行道。
  改用 `editor.parseEditorState()` + `editor.setEditorState()` 后双向可控，且实测内容能扛住
  连续 React 重渲染（流式输出期间）并进入编辑器 history（Ctrl+Z 可回退），确认走的是正规更新管线。
  这一结论推翻了设计文档里预设的 L1/L2/L3 三级降级方案。

- **回读校验以 editor state 为权威，不以 `innerText` 判等。**
  真机实测：Lexical 用 `<p>` 渲染每个段落，`innerText` 会把块级元素当独立行读，
  于是 `"A\nB"` 被读成 `"A\n\nB"`（每个段落之间多一个换行）。写入本身完全正确
  （editor state 逐字一致，159 字样本 `lexMatch: true`），但拿 `innerText` 判等会让
  **每一次多行写入都误判成失败** —— 这是首轮真机点击时暴露的实际故障（`readback-mismatch`）。
  同时把撤销栈失效判定、置灰判断、二次读草稿比对统一到同一基准（`readDraftCanonical`），
  避免两种标准互相比对导致"刚写完就被判成用户已修改"。

- **定位循环用 rAF + `setInterval` 双调度，不能只靠 rAF。**
  Chromium 在窗口隐藏/最小化/后台时会暂停 `requestAnimationFrame`。只用 rAF 自调度时，
  窗口切到后台后循环彻底停摆：按钮停在旧位置（工具行重排后压住原生「后台任务」按钮，
  x=497 覆盖 493–531），composer 引用也会丢失（`draftLen: -1`，按钮完全无响应）。
  改为 rAF 为主 + 每 400ms `setInterval` 兜底，并在 `visibilitychange` / `focus` 时立即校正。

- **主进程与渲染端用本地 HTTP 桥通信，而非 IPC。**
  渲染端没有 `nodeIntegration`，拿不到 `ipcRenderer`。本地桥同时解决了三个需求：
  apiKey 只留在主进程、支持流式进度回推、不依赖宿主内部 IPC 通道名（那些是内部实现，会变）。

- **修正 SSE 解码：`TextDecoder` 而非 `String(chunk)`。**
  undici 的 `fetch` 返回 `Uint8Array`，`String(uint8)` 得到的是 `"1,2,3"` 这样的字节列表，
  SSE 一行都切不出来。该缺陷由单元测试暴露，若带进真实环境会表现为"永远返回空内容"。

- **diff 卡必须受视口高度约束。**
  首版只给正文区设了 `46vh`，但头部+图例+底栏叠加后总高可能超过视口，真机截图显示
  卡片顶出屏幕、关闭按钮被窗口标题栏遮住。改为卡片整体 `maxHeight = innerHeight - 16`，
  正文区按剩余空间动态收缩，最终位置一律夹紧在视口内。

### 已知限制

- ZCode 每次升级会整份替换 `app.asar`，注入随之丢失（按钮静默消失）。需重跑 `node repatch_asar.mjs` 并重启。
- 增强模型不跟随输入框当前选中的模型（那是 React 内部 state，渲染端读不到）。用 `config.json` 指定，默认取配置里的第一条可用路由。
- 上下文感知（`<conversation_context>`）已预留接口但默认关闭（`context_enabled: false`）。
