# AGENTS.md — zcode-prompt-enhance

## 项目概览

ZCode 桌面版聊天输入框提示词增强插件：在输入框旁注入 ✨ 按钮，一键把草稿改写成结构化提示词。
实现方式为 asar 注入（`repatch_asar.mjs` 重打包宿主 `app.asar`），主进程链路（`inject-main.cjs` + `core/*.mjs`）
经本地 HTTP 桥与渲染端浮层（`overlay-prompt-enhance.js`）协同；另提供 `commands/enhance.md` + `skills/enhance`
作为注入失效期的 `/enhance` 对话兜底。当前版本 **v0.4.0**（2026-11-08），测试 171 项全绿。

## 构建与测试命令

Node >= 22，零第三方依赖（`dependencies: {}`），ESM（`"type": "module"`）。以下命令均来自 `package.json` scripts：

| 命令 | 作用 |
|---|---|
| `npm test` | 跑全部测试（`node --test "test/*.test.mjs"`，node:test 内建 runner） |
| `npm run build:overlay` | 从 `core/diff.mjs` 单一源生成 overlay 内嵌块（`tools/build-overlay.mjs`） |
| `npm run patch` | 执行 asar 注入部署（要求 ZCode 完全退出） |
| `npm run patch:dry` | 部署演练（不落盘） |
| `npm run patch:check` | 校验注入状态与产物一致性 |
| `npm run uninstall` | 卸载注入 |
| `npm run e2e` | 端到端模型链路验证（`tools/e2e-model.mjs`） |

无 CI workflow；改 `core/diff.mjs` 后必须先 `build:overlay` 再跑测试（一致性用例校验的是产物）。

## 代码风格约定

- 全部 ESM：主进程桥 `inject-main.cjs` 用 `.cjs`（asar 环境要求），其余 `core/`、`tools/`、`test/` 一律 `.mjs`。
- `core/*.mjs` 保持纯函数、可独立测试（node:test 直测）；副作用集中在 `inject-main.cjs` 接线层。
- 错误码与 provider 路由统一在 `core/provider.mjs` 归一化；任何路径**绝不回显 apiKey**。
- 测试文件与被测模块同名对应（`test/*.test.mjs`）；含静态守护用例（如禁止 `execCommand('insertText')`、禁止碰卡片 `marginBottom`）。

## 提交与发布规范

- Conventional Commits + 中文描述，近期实例：`feat(cli): ...`、`docs(handoff): ...`、`test(sim): ...`、`build(overlay): ...`、`chore(release): ...`。
- 变更随代码同分支写入 `CHANGELOG.md` 的 `[Unreleased]` 段（Keep a Changelog 六类结构）；README 中英双语同步修订。
- 发布走 annotated tag：`git tag -a vX.Y.Z -m "vX.Y.Z: <中文核心摘要>"`，推送后核验/创建 GitHub Release（标题同 tag，正文对齐 CHANGELOG）。

## 项目专属注意

1. **写入输入框只用 `setEditorState`，禁用 `execCommand`**；写完必须回读 DOM + editor state 双比对（`readback-mismatch` 即报错）——Lexical 的 `innerText` 与 editor state 不是等价表示，判等一律用 editor state。
2. **浮层 DOM 只挂 `body`**，不得插入 React 管理的子树；遮挡判定豁免 `#zpe-*`，定位循环必须有 `setInterval` 兜底（窗口隐藏时 rAF 停摆）。
3. **`repatch` / `uninstall` 前提是 ZCode 完全退出**；重启/关闭 ZCode 必须先获得用户书面确认，不得擅自执行。
4. **流式超时必须 `iterator.return()`** 释放上游（否则上游继续计费）；生成器产物（overlay 内嵌块）注释边界要显式闭合，产物校验不能只靠 `node --check` 语法检查，需靠 `test/overlay-diff.test.mjs` 行为级用例兜底。

接力开发优先阅读 `HANDOFF.md`（§6 关键避坑 27 条 + §7 待办）与 `CHANGELOG.md`。
