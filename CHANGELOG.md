# 变更日志

本项目的所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
