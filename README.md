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

### 指定增强用的模型

编辑 `config.json`：

```json
{
  "provider": "new-provider-2",
  "model": "cn:deepseek-v4.1-flash",
  "max_input_chars": 12000,
  "timeout_ms": 60000
}
```

留空 `provider` 与 `model` 则自动取 `~/.zcode/v2/provider_config.json` 里 `providerOrder` 的第一条可用路由。
两个字段都有格式白名单，任一非法会整组回落到默认，不会拼出畸形请求。

查看当前会选到哪个模型：

```bash
node tools/e2e-model.mjs      # 会真的调一次模型并把结果打印出来
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
| 弹出差异卡时按 Esc | 关闭差异卡 |

---

## 维护

### ZCode 升级后

```bash
node repatch_asar.mjs --check    # 退出码 1 = 注入已丢失
node repatch_asar.mjs            # 重新注入（需先完全退出 ZCode）
```

也可先确认官方是否已经内置了增强功能（一旦有，本项目即可弃用）：

```bash
node -e "const b=require('fs').readFileSync('F:/software/Zcode/resources/app.asar');const s=b.toString('latin1');console.log('enhancePrompt 调用点:', s.split('enhancePrompt').length-1)"
```

### 开发

改 `overlay-prompt-enhance.js` 或 `core/*.mjs` **不需要重启**：注入层每 2 秒检查 mtime，
变化后会自动重注入（会先用 `new Function` 校验语法，写到一半的保存不会污染运行中的页面）。

```bash
npm test                          # 102 项单测
node tools/preflight.mjs          # 静态体检（id 唯一性、安全断言、接口对齐）
node tools/bridge-selftest.mjs    # 桥接层自测（含真实模型调用）
node tools/check-asar-loadable.mjs  # 确认 patched asar 可正常加载
node tools/sim-overlay.mjs        # 模拟 DOM 跑完整交互链路（含 rAF 停摆回归）
node tools/check-anchor.mjs       # 用真实按钮矩形验证 ✨ 定位不压原生按钮
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

## 设计要点

更完整的设计分析与风险表见 [`DESIGN.md`](DESIGN.md)，接力开发信息见 [`HANDOFF.md`](HANDOFF.md)。

几条踩过坑之后定下的规则：

- **草稿写入走 Lexical 公开 API**（`parseEditorState` / `setEditorState`）。
  旧式 `execCommand('insertText')` 能写不能删 —— Lexical 的 selection 与 document selection 不同步，
  写进去之后程序化清除全部失效。
- **回读校验以 editor state 为权威，不拿 `innerText` 判等。**
  Lexical 用 `<p>` 渲染段落，`innerText` 在段落之间会多一个换行（`A\nB` 读成 `A\n\nB`）。
  写入本身没问题，但用 `innerText` 判等会把每一次多行写入都误判成失败。
- **定位循环不能只靠 `requestAnimationFrame`。** 窗口隐藏时 Chromium 会暂停 rAF，
  循环停摆后按钮会停在旧位置（压住原生按钮）且失去响应。已加 `setInterval` 兜底。
- **apiKey 只在主进程**。渲染端通过本地回环桥（随机端口 + 随机 token）请求，页面里拿不到凭据。
- **超时必须显式关闭上游流**。仅停止等待会让上游继续产 token、照旧计费。
- **浮层挂 `body` 绝对定位**，不插入 React 管理的子树（重渲染会擦掉），也不碰卡片让位边距（状态栏在用）。

## 许可

MIT
