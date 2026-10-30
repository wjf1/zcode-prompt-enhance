# zcode-prompt-enhance

在 ZCode Desktop 的聊天输入框旁加一个 ✨ 按钮：点一下，把草稿改写成结构化、可直接使用的提示词，
**原地回填**到输入框，原文可逐层撤销。

对标 [`wjf1/dsh-prompt-enhance`](https://github.com/wjf1/dsh-prompt-enhance)（DeepSeek Harness 插件）。

[English](README.en.md) | 简体中文

---

## 它做什么

```
┌─────────────────────────────────────────────────┐
│  草稿区域（你输入的内容）                        │
│                                                 │
│  [📎] [✨]↺⇄      [上下文用量] [模型 ▾] [发送]  │  ← ✨ 插在工具行，模型选择器左侧
└─────────────────────────────────────────────────┘
```

- **点 ✨** → 草稿被改写成结构化提示词，原地替换，不弹窗、不自动发送。
- **点 ↺** → 恢复上一版原文（撤销栈 8 层，可逐层退回）。
- **点 ⇄** → 弹出差异对比卡，标出每一处新增与删除。
- **增强中再点 ✨** → 取消当前请求，草稿逐字节不变。
- **失败时** → 按钮变红，hover 显示中文原因；再点即重试。

### 改写策略

模型按六段式骨架补全：角色与目标、上下文与约束、执行步骤、输出格式、验收标准、边界条件。
三条硬约束保证结果可用：

1. **不臆造**。缺失的关键信息用 `(待补充：…)` 占位，而不是编一个。
2. **语言一致**。中文输入 → 中文提示词，英文输入 → 英文提示词，混排保持混排。
3. **范围不变**。不扩大、不缩小、不改变任务意图。

例如输入 `帮我把这个函数改快一点`，输出是一份包含性能工程师角色设定、待补充信息清单、
四步执行计划、输出格式与验收标准的完整提示词。

---

## 为什么需要 asar 注入

ZCode 的插件体系**无法**实现"按钮贴输入框 + 就地回填"：

| 扩展点 | 限制 |
|---|---|
| Skill + 斜杠命令 | 结果只能进对话，需手动复制粘贴 |
| MCP 工具 | 拿不到当前草稿；结果同样进对话 |
| MCP App 侧栏 | 沙箱隔离读不到主窗口草稿；`ui/message` 是"发送"不是"回填"；`availability` 被锁死为会话级 |
| `UserPromptSubmit` hook | 输出 schema 只有 `additionalContext`，**没有** `updatedPrompt`，不能改写输入 |

所以本项目走 asar 注入：往客户端入口尾部追加一行 loader import，在主进程起服务、往渲染进程注浮层。
这与本机 [`zcode-token-usage-statusbar`](https://github.com/) 的注入方式一致，两者可以共存
（各自独立的注入标记，互不覆盖；本项目不碰状态栏在用的让位边距）。

> ⚠️ 这是非官方修改客户端。**每次 ZCode 升级后注入会消失**（客户端整份替换 `app.asar`），
> 重跑一次 `node repatch_asar.mjs` 并重启即可恢复。

---

## 安装

### 前置条件

- ZCode Desktop（本项目在 **3.16.3** 上开发验证）
- Node.js **≥ 22**
- 至少一个可用的 `anthropic-messages` 类型 provider（在 ZCode 里配好即可，本项目直接复用）

### 步骤

```bash
# 1. 装到任意目录
git clone <this-repo> zcode-prompt-enhance
cd zcode-prompt-enhance

# 2. 生成配置（一般不需要改，会自动选第一条可用 provider）
cp config.example.json config.json

# 3. 检查注入目标是否正确
node repatch_asar.mjs --dry-run

# 4. 完全退出 ZCode（托盘菜单 Quit），然后注入
node repatch_asar.mjs

# 5. 重新打开 ZCode，按钮应该出现在输入框工具行
```

第 4 步会自动安装 `@electron/asar`（约 20 秒），之后解包 → 备份 → 追加 → 重打包（约 1–3 分钟）。
ZCode 运行时会持有文件句柄，**必须先完全退出**。

### 增强用哪个模型

**默认实时跟随当前会话选中的模型**——你在输入框右下角切到哪个模型，点 ✨ 就用哪个模型增强。

跟随的判定方式：读取工具行模型按钮的标签文本，用「已知模型 id 是否被标签包含」反查
`provider_config.json` 里的真实清单。不解析模型名（模型 id 自身可能含 `/`），所以界面文案
带「最高 / 高 / 中 / 低」等思考档位后缀也不影响。

**跟随失败会自动回落**，不会让功能失效：

| 情况 | 行为 |
|---|---|
| 会话模型在 `provider_config.json` 里且有 apiKey | 直接用该模型增强 |
| 该 provider 额度耗尽 / 鉴权失败 / 网络不通 / 超时 | 自动改用默认模型再试一次，并提示「会话模型不可用，已改用 …」 |
| 订阅制 / OAuth 登录的 provider（配置里无 apiKey） | 回落到默认模型 |
| 界面改版导致读不到标签 / 反查有歧义 | 回落到默认模型 |

增强成功后浮层会提示实际用的模型，例如「已按会话模型增强：cn:deepseek-v4.1-flash」。

想固定用某个模型（不跟随），在 `config.json` 里填 `provider` 与 `model` 即可；
两者留空则跟随。

```json
{
  "provider": "",
  "model": "",
  "max_input_chars": 12000,
  "timeout_ms": 60000
}
```

> ⚠️ 注意：`config.json` 里填了 `provider`/`model` 只是**默认值**——跟随成功时仍然优先用会话模型。
> 想让增强固定用某个模型，把会话的模型也切过去；或者接受跟随失败时的回落值。

查看当前会跟随到哪个模型：

```bash
node tools/check-model-follow.mjs     # 用真机 aria 样本验证匹配算法
node tools/check-follow-live.mjs      # 真实解析 + 真实调用每个路由
```

---

## 日常使用

| 操作 | 结果 |
|---|---|
| 草稿为空时看 ✨ | 置灰，hover 提示"请先输入需要增强的提示词" |
| 点 ✨ | 转圈开始增强；再点 = 取消 |
| 增强成功 | 草稿原地替换，弹出差异卡，出现 ↺ 与 ⇄ |
| 点 ↺ | 退回上一版；连续增强可逐层回退（最多 8 层） |
| 自己改动草稿 | 撤销栈整栈失效（避免撤销到你没预期的旧版本） |
| 增强过程中改草稿 | 结果被丢弃，提示"草稿已修改，已放弃增强结果" |
| 弹出差异卡时按 Esc | 关闭差异卡（仅当焦点在卡片内，不影响宿主自己的 Esc 处理） |
| 按钮位置持续不对 | 5 秒后提示一次"按钮位置可能不准（界面布局已变化）" |
| 自己改动草稿导致撤销栈清空 | 提示"撤销历史已清空" |

---

## 维护

### 安全模型（0.3.0 起）

桥 token 是进程生命周期内的随机常量，**永不过期**。因此注入面本身必须收窄：

- 只向**可信窗口**注入：默认仅本地打包协议（`file:` / `app:` / `chrome-extension:` / `devtools:`）。
  远程页面默认一律不注入，除非把主机名显式写进 `config.json`：
  ```json
  { "allowed_window_hosts": ["zcode.z.ai"] }
  ```
  当前实测主窗口走 `loadFile(.../renderer/index.html)`，即 `file:`，默认配置即可正常工作。
- 桥在 token 校验**之前**校验 `Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`
  （防 DNS rebinding：攻击者域名可解析到 127.0.0.1，但 Host 头会是其域名）。

### 诊断接口

```bash
curl -s -H "x-zpe-token: <token>" http://127.0.0.1:<port>/health
```

`/health` 返回 `configPath` 与 `configShape`（`anthropic-v2` / `unknown` / `missing`），
用来区分"没有配置 / 配置目录改版 / 配置格式变了"三种失败，不用再靠猜。

页面内 `window.__zpeState()` 额外暴露 `anchorDegraded` 与 `anchorVia`。
`anchorVia` 不是 `cluster` 就说明工具行布局已经不是已知形状，定位正在降级运行。

### ZCode 升级后

```bash
node repatch_asar.mjs --check    # 退出码 1 = 注入已丢失
node repatch_asar.mjs            # 重新注入（需先完全退出 ZCode）
```

也可先确认官方是否已经内置了增强功能（一旦有，本项目即可弃用）：

```bash
node -e "const b=require('fs').readFileSync('E:/ZCode/resources/app.asar');const s=b.toString('latin1');console.log('enhancePrompt 调用点:', s.split('enhancePrompt').length-1)"
```

### 开发

改 `overlay-prompt-enhance.js` 或 `core/*.mjs` **不需要重启**：注入层每 2 秒检查 mtime，
变化后会自动重注入（会先用 `new Function` 校验语法，写到一半的保存不会污染运行中的页面）。

```bash
npm test                          # 140 项单测
node tools/preflight.mjs          # 静态体检（id 唯一性、安全断言、接口对齐）
node tools/bridge-selftest.mjs    # 桥接层自测（含 Host 校验与真实模型调用）
node tools/inject-gate-selftest.mjs  # 注入门禁时序自测（stub electron，防空 URL 拒注回归）
node tools/check-core-url.mjs     # core 模块能否用 file:// URL 正常导入
node tools/check-asar-loadable.mjs  # 确认 patched asar 可正常加载
node tools/sim-overlay.mjs        # 模拟 DOM 跑完整交互链路（rAF 停摆、定位缓存、无障碍断言）
node tools/check-multiline.mjs    # 多行草稿读写往返
node tools/verify-writedraft.mjs  # 真机多行写入一致性（editor state 判定）
node tools/peek.mjs               # 真机单次取证：读取当前浮层状态与 DOM 断言
node tools/e2e-model.mjs          # 真实模型端到端
```

### 卸载

```bash
node uninstall.mjs    # 移除注入行，还原客户端（需先完全退出 ZCode）
```

只移除本项目那一行，不影响状态栏项目的注入。

---

### 已知限制

- ZCode 每次升级会整份替换 `app.asar`，注入随之丢失（按钮静默消失）。需重跑 `node repatch_asar.mjs` 并重启。
- 跟随会话模型依赖读取工具行按钮的标签文本。界面结构变化会导致读不到，
  此时回落到默认模型（功能仍可用，只是不再跟随）。
- `allowed_window_hosts` 默认为空。若某次改版把主窗口改成远程加载，按钮会消失；
  把实际主机名填进该字段即可。**不要**为了省事默认放行所有 `http/https`。
- 工具行被原生按钮完全占满时，✨ 会隐藏而不是叠在发送按钮上 —— 这是有意的取舍，不是故障。

## 设计要点

更完整的设计分析与风险表见 [`DESIGN.md`](DESIGN.md)，接力开发信息见 [`HANDOFF.md`](HANDOFF.md)。

几条踩过坑之后定下的规则：

- **草稿写入走 Lexical 公开 API**（`parseEditorState` / `setEditorState`）。
  旧式 `execCommand('insertText')` 能写不能删 —— Lexical 的 selection 与 document selection 不同步，
  写进去之后程序化清除全部失效。
- **回读校验以 editor state 为权威，不拿 `innerText` 判等。**
  Lexical 用 `<p>` 渲染段落，`innerText` 在段落之间会多一个换行（`A\nB` 读成 `A\n\nB`）。
  写入本身没问题，但用 `innerText` 判等会把每一次多行写入都误判成失败。
  0.3.0 起 `innerText` 只用于轮询的"没变"短路，绝不参与判等。
- **定位循环不能只靠 `requestAnimationFrame`。** 窗口隐藏时 Chromium 会暂停 rAF，
  循环停摆后按钮会停在旧位置（压住原生按钮）且失去响应。已加 `setInterval` 兜底。
- **落点宁可隐藏也不遮挡原生 UI。** 找不到不压任何原生按钮的空隙时返回 `hidden`。
  「贴右下角」这条退路在 3.16.3 的真实矩形下会直接压住发送按钮 ——
  安全退路必须被验证过才叫安全。
- **apiKey 只在主进程**。渲染端通过本地回环桥（随机端口 + 随机 token + Host 校验）请求，页面里拿不到凭据。
- **超时必须显式关闭上游流**。仅停止等待会让上游继续产 token、照旧计费。
  超时回落只在"一个 token 都没吐"（`hadFirstChunk === false`）时执行，否则一次点击会烧双份额度。
- **浮层挂 `body` 绝对定位**，不插入 React 管理的子树（重渲染会擦掉），也不碰卡片让位边距（状态栏在用）。

## 许可

MIT
