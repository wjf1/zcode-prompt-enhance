# HANDOFF.md — 接力开发文档

> 项目：zcode-prompt-enhance（ZCode 提示词增强）
> 当前阶段：**v0.3.2 已随 ZCode 3.17.1 重新注入，待重启验证**
> 最后更新：2026-10-30

---

## 1. 项目概况与当前状态

| 项 | 值 |
|---|---|
| 项目定位 | ZCode Desktop 输入框旁 ✨ 一键增强提示词，原地回填 + 撤销 + diff |
| 版本 | `0.3.2` |
| 位置 | 开发与部署统一在 `F:\AI\Zcode\zcode-prompt-enhance`（注入行指向此处） |
| 仓库 | https://github.com/wjf1/zcode-prompt-enhance |
| 目标宿主 | ZCode Desktop **3.17.1**（2026-10-29 升级），实际装于 `E:\ZCode`（`F:\software\Zcode` 已不存在） |
| 当前状态 | **ZCode 升级 3.17.1 导致注入丢失，2026-10-30 15:27 已重新注入（PATCHED 核验通过），待完全退出 ZCode 重启生效** |

### 0.3.0 相对 0.2.0 的一句话差异

0.3.1 修掉 0.3.0 的注入回归（窗口创建时空 URL 被拒，按钮从未出现）。
0.3.0 修掉「安全退路反而压住发送按钮」的定位炸弹（`anchorFor` 重叠自检 + 步进避让），
收窄桥令牌注入面（可信窗口判定 + Host 校验），并把三类静默失败
（定位劣化、配置格式变更、编辑器不兼容）变成可观测状态。测试 118 → 140。

### 当前注入状态

**✅ 2026-10-30 15:27 已随 ZCode 3.17.1 重新注入，等待重启生效。**

```
实际运行位置：E:\ZCode\resources\app.asar（2026-10-29 21:04 随 3.17.1 升级被整份替换，374,627,566 字节）
  __ZPE_PATCH__    ✅ true（本项目，2026-10-30 15:27 注入）
  __ZUSAGE_PATCH__ ✅ true（状态栏项目，2026-10-30 同日随其后重新注入，~/.zcode/zcode-token-usage-statusbar）
备份：E:\ZCode\resources\app.asar.bak-zpe-20261030152738（本项目注入前副本；含 .bak-20261030 等共 3 份轮转）
注入行：2 行（本项目 + 状态栏），check-asar-loadable ALL PASS
部署路径：F:\AI\Zcode\zcode-prompt-enhance = 开发路径（v0.3.2）
  —— npm test 140/140、tools/preflight ALL PASS、tools/check-asar-loadable ALL PASS（3.17.1 asar 可加载）

历史：ZCode 每次升级都会整份替换 asar 导致注入丢失（已两次：迁移到 E:\ZCode、
2026-10-29 升级 3.17.1）。2026-10-30 已重新注入，注入方式沿用运行中直接替换
+ 用户方便时重启的路径（10-26 实测安全）。
```

0.3.1 追记：首次重启（23:21）后桥活着但按钮未出现 → 定位到 0.3.0 注入门回归
（web-contents-created 时空 URL 被拒，见 CHANGELOG 0.3.1）。已在部署路径就地修复 loader
与 overlay（**asar 无需重打**）：overlay 改 mtime 会被运行中的会话热注入，loader 修复需再次重启生效。
验证链：`tools/inject-gate-selftest.mjs` 在旧代码上 4 FAIL（负对照），修复后 ALL PASS。

### 4.0.2 v0.3.2：ZCode 3.17.1 重新部署 + 工具链路径修复

ZCode 于 2026-10-29 升级到 **3.17.1**，asar 被整份替换（374,627,566 字节），本项目与
状态栏项目的注入同时丢失。本次会话完成：

1. **重新注入**（2026-10-30 15:27，运行中直接替换 + 备份 `app.asar.bak-zpe-20261030152738`），
   `repatch --check` = PATCHED，`check-asar-loadable` 对 3.17.1 的 asar ALL PASS；
2. **修复硬编码旧安装路径 `F:/software/Zcode`**（ZCode 迁到 E:\ZCode 后遗留）：
   - `tools/check-asar-loadable.mjs`（真 bug：单一路径必挂）改为与 repatch 相同的候选探测，
     支持 `--asar` / `ZPE_ASAR`；`loaders.length === 2` 的硬性断言放宽为 `>= 1`
     （2 行 = 状态栏项目也在；状态栏丢失时如实报告而非误报本项目失败）；
   - `repatch_asar.mjs` / `uninstall.mjs`：删除 `F:/software` 死候选（无害但易误导）；
   - `test/trust.test.mjs` 样本 URL、README×2 / HANDOFF 查证命令示例同步更新到 `E:/ZCode`；
3. **GitHub 侧同步**：远程 main 曾领先本地 2 个文档提交（LICENSE + HANDOFF 回填），
   已 ff-only 拉齐；本版随 0.3.2 tag 推送并发布 Release。

验证：npm test 140/140、preflight ALL PASS、check-asar-loadable ALL PASS。
**运行时行为零变更**——纯工具链 / 文档修复，0.3.1 的注入逻辑原样重新部署。
追记：状态栏项目 `__ZUSAGE_PATCH__` 已于同日随后重新注入（见「当前注入状态」），两行 loader 齐；
3.17.1 真机走查待重启（见 §5.1.1）。

⚠️ **注入的 loader 只在主进程启动时加载。当前 ZCode 进程仍在跑注入前的代码——
需要完全退出 ZCode（托盘 → Quit）再重新打开。**

⚠️ **0.3.0 改了 `inject-main.cjs` 与 `core/*.mjs`，这些只在主进程启动时加载。**
重启后生效；overlay 文件本身走 mtime 热更新，但它的新逻辑依赖主进程侧的新字段，
不要指望热更新单独生效。

---

## 2. 技术栈与运行基线

| 项 | 约束 |
|---|---|
| 运行时 | Node.js **≥ 22**（实测 v22.23.2） |
| 语言 | 注入层 `.cjs`（主进程 CommonJS）；核心逻辑 `.mjs`；浮层是纯 IIFE 字符串注入 |
| 运行时依赖 | **零**（prompt / diff / gates / SSE / trust 全手写） |
| 开发期依赖 | `@electron/asar`，自动装到 `.asar-tools/`（首次 `repatch` 时） |
| 测试 | `node --test "test/*.test.mjs"`（Node 内置，**140 项**） |
| 模型协议 | Anthropic Messages，`POST {baseUrl}/messages`，SSE 流式 |

### 核心命令

```bash
node repatch_asar.mjs --dry-run        # 只解析路径 + 报告是否已注入
node repatch_asar.mjs --check          # 退出码 1 = 注入已丢失
node repatch_asar.mjs                  # 注入（需先完全退出 ZCode）
node uninstall.mjs                     # 移除注入，还原（需先完全退出 ZCode）
npm test                               # 140 项单测
node tools/preflight.mjs               # 静态体检
node tools/check-core-url.mjs          # core（含 trust）能否用 file:// 导入
node tools/bridge-selftest.mjs         # 桥接自测（含 Host 校验 + 真实模型调用）
node tools/inject-gate-selftest.mjs    # 注入门禁时序自测（stub electron，0.3.1 新增）
node tools/check-asar-loadable.mjs     # 确认 patched asar 可加载
node tools/sim-overlay.mjs             # 模拟 DOM 全链路（rAF 停摆 / 定位缓存 / 无障碍）
node tools/verify-writedraft.mjs       # 校验多行写入的 editor state 一致性
node tools/e2e-model.mjs               # 真实模型端到端
```

### 本机实测基线

- 可用 provider（2026-10-26 晚实测，E:\ZCode 时代的 provider_config）：
  - `new-provider-4` / `workbuddy 代理` → `http://127.0.0.1:7863/v1`，`cn:deepseek-v4.1-flash` —— **有额度**，
    已写入部署路径 `config.json` 作为默认路由（改 config 后不需重启，下一次点 ✨ 即生效）
  - `64a1207f-...` / `commandcode` → `http://127.0.0.1:9090/v1` —— 上游额度耗尽（HTTP 400 insufficient credits）
  - `new-provider` / `新供应商` → `localhost:20128`，`new-provider-3` / `Gemini` → `127.0.0.1:8045` —— 本机服务未启动
- ⚠️ provider id 会随 provider_config 重写而漂移（v0.2.0 时代 workbuddy 叫 `new-provider-2`，
  现在叫 `new-provider-4`）—— 引用 id 前先跑 `listRoutes` 现查，不要相信文档快照
- 会话模型标签（如 `GLM-5.3-Flash 最高`）在 provider_config 里无命中项 → 增强固定走默认路由
- 输入框实测：`[contenteditable="true"]`，矩形 `[345,621,836,40]`；卡片 `[333,608,861,105]`
- 工具行按钮（y=673、高 28）：添加上下文 x=345 / 切换模式 x=377 / 后台任务 x=493 /
  上下文用量 x=900 / 模型选择器 x=932(w218) / 发送或停止 x=1153
- 主窗口加载方式实测（`E:\ZCode\resources\app.asar` 内 `loadWindow`）：
  `e.loadFile(.../renderer/index.html)` → **`file:` 协议**，因此 `allowed_window_hosts` 留空即可。

---

## 3. 核心架构与文件拓扑

```
F:\AI\Zcode\zcode-prompt-enhance\
├── inject-main.cjs              # 主进程 loader：注入浮层、起本地桥、provider 路由、三闸门
├── overlay-prompt-enhance.js    # 渲染端浮层（IIFE 字符串注入）：按钮/读写/撤销栈/diff 卡
├── core/
│   ├── prompt.mjs               # system prompt + frameUserPrompt + cleanEnhancedText
│   ├── provider.mjs             # provider_config.json 候选路径探测 + 形状判定 + 白名单 + 路由选择
│   ├── enhancer.mjs             # SSE 客户端 + 竞速超时 + 错误码归一化 + hadFirstChunk 标记
│   ├── diff.mjs                 # token 级 LCS（中文逐字/英文词级）
│   ├── gates.mjs                # 熔断 → 限流 → 并发
│   └── trust.mjs                # 窗口 URL 可信判定（0.3.0 新增，纯函数、零依赖）
├── repatch_asar.mjs             # 解包→追加 __ZPE_PATCH__→重打包→替换（3 份备份）
├── uninstall.mjs                # 移除注入行（导出 stripLoader 供测试）
├── test/                        # 9 个测试文件，140 项
├── tools/                       # 13 个校验/探针脚本
├── config.json / config.example.json
└── README.md / README.en.md / CHANGELOG.md / DESIGN.md / APPENDIX.md / HANDOFF.md
```

### 3.1 数据流

```
[浮层] 点击 ✨
   ↓ 读草稿 composerEl.innerText
   ↓ POST http://127.0.0.1:<随机端口>/enhance  (header: x-zpe-token)
[主进程本地桥]
   ↓ 校验 token → 校验长度（超限 413，不截断）→ 三闸门
   ↓ 读 config.json 的 provider/model → 解析 provider_config.json 拿到 baseUrl + apiKey
   ↓ POST {baseUrl}/messages  (SSE)
   ↓ 逐块 onProgress → 以 NDJSON 行回推 {"type":"progress"}
   ↓ 清洗 → {"type":"done","text":...}
[浮层] 收到 done
   ↓ 二次读草稿比对（请求期间用户改过 → 放弃结果）
   ↓ editor.setEditorState(parseEditorState(...))
   ↓ 回读校验（innerText + editor state 双比对）
   ↓ 成功：入撤销栈 + 计算 diff + 弹差异卡
```

### 3.2 SSOT

| 数据 | 位置 |
|---|---|
| provider 凭据与路由 | `~/.zcode/v2/provider_config.json` → `config.providerConfigRules.providerRules[]` + `config.providerOrder` |
| 本项目配置 | `config.json`（gitignore） |
| 提示词模板 | `core/prompt.mjs`，改动必须同步 `test/prompt.test.mjs` |
| diff 算法 | `core/diff.mjs` **与** overlay 内的 `zpe*` 副本，两者由 `test/overlay-diff.test.mjs` 强制一致 |

### 3.3 与状态栏项目的边界（关键）

| 维度 | zcode-token-usage-statusbar | 本项目 | 冲突处理 |
|---|---|---|---|
| 注入标记 | `__ZUSAGE_PATCH__` | `__ZPE_PATCH__` | 各自幂等守卫 |
| 注入方式 | 入口尾行 append | 同 | `repatch` 解包当前 asar 再 append，保留对方行（已验证） |
| 卡片让位边距 | 读写 `marginBottom` | **完全不碰**（有静态测试守住） | — |
| DOM id | `zusage-*` | `zpe-*` | 不撞 |
| 定位逻辑 | `deepFind` / `cardOf` | 复制一份，不 require 对方 | 独立部署 |

---

## 4. 最近一轮变更与交付成果

### 4.0 v0.3.0（当前）：加固与适配

按一份外部开发任务书（T01–T11）执行，全部完成。核心是三个 P0：

**（1）✨ 落点会压住发送按钮（T01）**

`anchorFor` 的 fallback 退路是「卡片右下角内缩 40/34」。在 `test/anchor.test.mjs` 记录的真实矩形下
（卡片 `right=1194`、发送按钮 `1153-1181 × 673-701`）它落在 `1154,679`，按钮占 `1154-1182 × 679-707`
—— **矩形直接相交**。而工具行识别失败（UI 改版）正是 fallback 生效之时，所以"安全退路"恰好在最需要它的时候压住发送。

修复：三个候选落点统一过 `settle()`。与任何原生按钮矩形相交时，沿同一行左右步进（8px × 最多 24 步）
找空隙；找不到则返回 `hidden`（按钮隐藏），`place()` 里检测到 `left === null` 就 `display:none`。
无按钮场景（`row.length === 0`）保持原行为直接落右下角。

**踩坑记录**：重叠判定必须用 `top+height` / `left+width` 推导右下角。测试 mock 的按钮矩形没有
`bottom` 字段，直接读 `r.bottom` 会得到 `undefined`，比较恒为 false —— 测试全绿但线上照压。

**（2）卡片容器误判导致三处锚点漂移（T02）**

`cardOf` 原先遇到「有边框或非透明背景」的祖先就当卡片。3.16.2 起输入框内部新增了带背景的模型切换条，
那个内层容器被当成卡片，按钮 / diff 卡 / toast 一起漂。
新增 `plausibleCard`：① 宽度 ≥ composer 的 90%；② 下半部有 ≥2 颗 16–44px 按钮。
兜底 `return last` 保留（绝不返回 null，否则 `place()` 崩、按钮永久消失）。

**（3）桥令牌注入面过宽（T04）**

`isMainWindow` 只判 `wc.getType() === "window"`，不校验 URL；token 是进程级常量、永不过期。
任一 window 型窗口若加载远程内容即可读到 token，用用户 apiKey 代发请求。
- 新增 `core/trust.mjs`：默认只信任 `file:` / `app:` / `chrome-extension:` / `devtools:`，
  远程主机必须显式列进 `config.json` 的 `allowed_window_hosts`。
- 桥在 token 校验**之前**校验 `Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS rebinding）。

**其余（T03 / T05–T11）**

| 任务 | 内容 |
|---|---|
| T03 | `via !== "cluster"` 持续 5s 提示一次；`place()` catch 首次 `console.warn`；`__zpeState()` 暴露 `anchorDegraded` / `anchorVia` |
| T05 | `retryable` 改查 `describeError(code).retryable`（原先硬编码让 `invalid-credential` 变成"可重试"） |
| T06 | `candidateConfigPaths` / `detectConfigShape` / `findConfig`；`/health` 增加 `configPath` + `configShape`；503 detail 三态化 |
| T07 | `enhanceDraft` 记录 `hadFirstChunk`；桥只在"一个 token 都没吐"的超时才回落 |
| T08 | `place()` 卡片矩形签名缓存；400ms 兜底改 `place(true)`。实测 420ms 内工具行扫描 26 → 2 次 |
| T09 | `checkDraftChange` 用 `innerText` 廉价指纹短路；`syncDraftBaseline` 统一同步 |
| T10 | `probeLexical` 探针，新错误码 `lexical-incompatible` |
| T11 | 8 小项：`isDark` 透明背景误判、diff 首帧重取主题、toast 跟随主题、焦点往返、Esc 只拦卡内、error 随草稿复位、撤销栈深度可见、进度写 aria-label + `aria-expanded` |

**测试基础设施的两个既有空洞（本轮才发现，值得记住）**

1. `test/anchor.test.mjs` 的 mock `querySelectorAll` 只认 `"button"`，而 `findModelButton` 用的是
   `"button, [role='button']"` → **model 路径在测试里恒不可达**，所有右侧场景其实都落到 fallback。
   已让 mock 同时支持两种选择器。
2. `tools/sim-overlay.mjs` 的 `FakeNode` 有两个致命空洞：
   - `style` 不解析 `cssText`，`style.display` 恒为空串 → 所有 `display !== "none"` 判断都假绿
     （diff 卡"可见"断言一直没真正生效）；
   - 没有 `querySelector` → `positionDiff` 每帧抛 `TypeError`，被 `state.placeError` 静默吞掉，
     diff 卡定位从未被验证过。

   两处都已补。这也说明 T03 的"placeError 落日志"是有实际价值的 —— 正是它让第二个空洞暴露出来。

**验证数据**（2026-10-26）

| 项 | 命令 | 结果 |
|---|---|---|
| 单测 | `npm test` | **140 项全过**（基线 118 + 新增 22） |
| 静态体检 | `node tools/preflight.mjs` | ALL PASS |
| core 导入 | `node tools/check-core-url.mjs` | 4 个模块全 OK（含 trust） |
| 模拟链路 | `node tools/sim-overlay.mjs` | ALL PASS（含 T08 缓存、T11 主题/无障碍/Esc 断言） |
| 桥接自测 | `node tools/bridge-selftest.mjs` | ALL PASS（含真实模型调用、Host 校验、configShape） |
| retryable 一致性 | §T05 单行命令 | `invalid-credential → false`，与 core 表一致 |

### 4.0.1 v0.3.1：修复 0.3.0 注入回归

0.3.0 首次真机重启后：状态栏项目正常、桥接服务在 `127.0.0.1:54965` 正常监听
（`/health` 无 token 回 `403 {"code":"forbidden"}`，是我们桥的指纹），但 ✨ 按钮从未出现。

定位过程：进程路径/启动时间/asar 核验 → loader 已加载（桥活着） → 问题锁定在「往窗口注入」一环
→ 复查 0.3.0 改动：`web-contents-created` 入口被换成了 `isTrustedWindow`，而该事件触发时
`wc.getURL()` 是空串 → `trust.check("") = false` → 主窗口被当场拒绝，`did-finish-load` 钩子永远没挂上。

修复：两处入口（created + 初始遍历）恢复 `isMainWindow` 过滤，可信判定保留在 `inject()` 内。
新增 `tools/inject-gate-selftest.mjs`：stub electron 模拟完整时序，旧代码 4 FAIL（负对照实测），
修复后 ALL PASS；远程页面 / webview 拒绝的安全用例保持通过。

**asar 不需要重打**：注入行只负责 import 外部 loader，本次只改部署路径上的 loader / overlay。
overlay 改 mtime 即被运行中会话热注入；loader 修复需再次重启。

### 4.1 v0.2.0：实时跟随会话模型

用户提出的需求是「增强是否跟随当前对话的模型」。0.1.0 的答案是"不跟随"（固定用
`config.json` 的模型）。0.2.0 改为**默认跟随**。

**实现方式**：点 ✨ 时读工具行模型按钮的 `aria-label`，随请求上报给主进程；
主进程用「已知模型 id 是否被标签包含」的最长匹配反查路由。

**三个关键设计决定**：

1. **不解析模型名**。模型 id 自身可能含 `/`（`meta/muse-spark-1.3`、
   `deepseek/deepseek-v4.1-flash`），按分隔符切分必然出错。改为拿
   `provider_config.json` 的真实模型清单去 `label.includes(model)`，取最长匹配
   （防 `gpt-6` 抢先命中 `gpt-6-astra`），并做边界检查（前后不能紧邻
   `[A-Za-z0-9_.-]`），等长且指向不同路由判为歧义 → 安静回落。

2. **跟随失败必须自动回落**。真机实测发现：会话切到 `cmcode` 那个 provider 时额度已耗尽
   （HTTP 400 `insufficient credits`），若直接报错，用户会觉得"点了没反应"。
   现在对 `internal/quota/auth/invalid-credential/rate-limit/unsupported/timeout`
   这几类错误，自动用默认路由重试一次（**仅一次**，避免重复烧额度），
   并在浮层提示「会话模型不可用，已改用 …」。用户主动取消不触发回落。

3. **回落要可见**。增强成功后浮层提示实际使用的模型与来源
   （`已按会话模型增强：…` / `已用默认模型增强：…` / `会话模型不可用，已改用 …`）。
   `__zpeState()` 暴露 `sessionModelLabel` 与 `usedRoute`。

**优先级链**（`resolveRoute`）：跟随会话 → 显式 provider → 显式 model → 默认第一条。
传空标签时行为与 0.1.0 逐字节一致（有测试守住）。

**路由缓存**键加入会话标签 + `config.json` mtime，否则切模型后仍用旧路由。

**验证数据**（2026-10-26 实测）：

| 项 | 结果 |
|---|---|
| 跟随算法单测 | 13 项全过（真机 aria 样本、含 `/` 的 id、前缀碰撞、中文尾缀、等长歧义、无凭据 provider 不被选中） |
| 总测试 | **118 项全过** |
| 真实路由解析 | 6/6 标签全部 `follow-session` 命中正确 provider+model |
| 跟随可用模型 | workbuddy / cn:deepseek-v4.1-flash → 真实调用成功，返回 465 字 |
| 跟随不可用模型 | cmcode（额度耗尽）→ 如期报 `quota` → 回落 workbuddy → 成功返回 482 字 |
| 桥接自测 | 全过，无回归 |

### 4.2 v0.1.0 真机验收结果

用户点击 ✨ 后截图确认功能正常：

- ✨ 出现在工具行（`+` / `完全访问` / `1` / `✨` / `↺` / `⇄`），与原生图标同尺寸同风格
- 草稿被原地替换为完整六段式提示词（角色 / 任务 / 待补充信息 / 步骤 / 输出格式 / 验收标准 / 边界情况）
- 缺失信息以 `（待补充：请粘贴完整代码）` 占位，未臆造
- diff 卡弹出并显示 `8 处改动 · 504 字新增 / 5 字替换 · 净 +499 字`
- 删除项红色删除线、新增项绿色下划线，底部有「新增 / 删除」图例和「恢复原文」按钮
- 撤销 ↺ 与差异 ⇄ 按钮出现

客观 DOM 断言（`tools/peek.mjs`，单次只读取证）：
按钮 `[538,673,28,28]`、不压任何原生按钮、不与状态栏重叠、中心点命中自己、无重复 id、祖先链正确。

#### 4.2.1 v0.1.0 真机暴露并修复的三个缺陷

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | 按钮压在「后台任务」按钮上（x=497 覆盖 493–531），且此后完全不响应 | Chromium 在窗口隐藏时暂停 `requestAnimationFrame`，纯 rAF 自调度的定位循环彻底停摆；composer 引用随之丢失（`draftLen: -1`） | 改为 rAF + 每 400ms `setInterval` 双调度，`visibilitychange`/`focus` 时立即校正，并加 `rediscover()` 重新发现 composer |
| 2 | 点击后报 `readback-mismatch`，草稿未被改写，按钮变红 | 回读校验拿 `innerText` 与预期严格比对，但 Lexical 用 `<p>` 渲染段落，`innerText` 在段落间多一个换行（`A\nB` → `A\n\nB`）。写入本身完全正确（editor state 逐字一致） | 校验基准改为 editor state（权威），`innerText` 仅在无 editor 实例时兜底；撤销栈判定/置灰/二次读草稿统一到 `readDraftCanonical` |
| 3 | diff 卡顶出屏幕，关闭按钮被窗口标题栏遮住 | 只给正文区设了 `46vh`，头部+图例+底栏叠加后总高可能超过视口 | 卡片整体 `maxHeight = innerHeight - 16`，正文区动态收缩，最终位置一律夹紧在视口内 |

修复 2 的决定性证据（真机实测，159 字多行样本）：

```
lexMatch: true    ← Lexical editor state 与预期逐字一致（写入正确）
domMatch: false   ← innerText 多出 5 个字符，全是段落间换行
verdictOld: FAIL  ← 修复前判据（DOM 与 state 都要相等）
verdictNew: PASS  ← 修复后判据（只看 editor state）
```

#### 4.2.2 其余完成项

1. **P0 风险 R2 已打掉，且推翻了原设计方案**（详见 §5.4）。
2. **修正 SSE 解码缺陷**：`String(Uint8Array)` 得到字节列表，SSE 解析全废；改用 `TextDecoder`。
3. **实现全部模块**：core 五件套 + 主进程 loader + 渲染端浮层 + 注入/卸载脚本 + 12 个校验工具。
4. **测试 102 项全绿**，包含真机缺陷的三条回归用例（rAF 停摆、diff 卡视口约束、定位夹紧）。
5. **真实模型端到端验证**：中英文各一条，六段式结构完整、语言一致、缺失信息用占位符标注。
6. **注入完成并校验**：marker 在案、状态栏注入行保留、入口 ESM 语法通过 `--check`、
   两行 loader 目标文件都存在、unpacked 下 3 个 `.node` 原生模块在位。

### 关键文件

| 文件 | 说明 |
|---|---|
| `overlay-prompt-enhance.js` | 最大单文件；浮层 + 撤销栈 + diff 卡 + 页内 diff 副本 |
| `inject-main.cjs` | 主进程；本地桥用 `http.createServer` + 随机端口 + 随机 token |
| `core/enhancer.mjs` | SSE + 竞速超时 + `iterator.return()` 兜底（防上游继续计费） |

---

## 5. 接力开发指引与待办

### 5.1 已完成的真机验收

- [x] ✨ 出现在工具行，与原生图标同尺寸，不压任何原生按钮
- [x] 空草稿时置灰（`aria-disabled`，hover 有中文原因）
- [x] 输入文字 → 点 ✨ → 草稿被替换为六段式提示词
- [x] diff 卡弹出，统计行正确（`8 处改动 · 504 字新增 / 5 字替换 · 净 +499 字`）
- [x] 缺失信息用 `（待补充：…）` 占位，未臆造
- [x] 与状态栏**同屏共存**，无重叠、卡片边距未被污染

### 5.1.1 还需确认的项（2026-10-27 更新：重启已完成，0.3.1 已生效）

**重启已完成（2026-10-27 11:35），0.3.1 确认在跑**：进程 pid 10676 于 11:35:56 启动，
三个 0.3.1 文件访问时间落在之后（`core/trust.mjs` 11:37:40 —— 该文件 0.2.0 不存在；
`inject-main.cjs` 11:38:38；`overlay-prompt-enhance.js` 11:38:51），桥接服务由主进程监听
`127.0.0.1:63619`，`repatch_asar.mjs --check` 返回 `PATCHED`。**阻塞项 P0 的重启部分已解除。**

**走查进展（2026-10-27）：1 项真机 + 5 项模拟器覆盖，2 项无法验证、1 项无覆盖。**

- [x] **按钮仍出现** —— 真机已确认：主窗口可访问性树中存在 `kind=button`、
      `title="请先输入需要增强的提示词"`、带 `AXPress`，且位置紧跟 token 计量（`t/s`）之后，
      确在输入区工具行。可信窗口判定未误拒主窗口。
- [x] **撤销 ↺ 复验** —— `tools/sim-overlay.mjs` [6] 覆盖：草稿恢复原文、栈清空、diff 关闭；
      [11] 覆盖栈深度 2 时 title 含「还可 2 步」。ALL PASS。
- [x] **Esc 行为** —— [11.5] 覆盖「焦点不在卡内时 Esc 不被吞（未调用 stopPropagation）」。ALL PASS。
- [x] **浅色主题** —— [11] 覆盖：toast 背景取浅色变量、不再是硬编码 `rgba(30,30,32)`。ALL PASS。
- [x] **diff 卡位置** —— [3]/[10] 覆盖：卡片可见、矩形不变时不重复扫描、缓存期间仍在正确位置。ALL PASS。
- [ ] **`anchorDegraded` / `anchorVia === "cluster"`** —— `sim-overlay.mjs` 对此**零覆盖**
      （grep `anchorDegraded` 命中 0）。需在真实窗口控制台执行 `window.__zpeState()` 读取。
- [ ] **取消复验**（增强中再点 ✨ 能取消且草稿不变）—— 模拟器无对应用例，需真机操作。
- [ ] **工具行被原生按钮完全占满时 ✨ 隐藏** —— 模拟器无对应用例（grep `占满` 命中 0），
      属极端布局，需构造场景。

**走查受阻说明**：2026-10-27 尝试真机点击时，会话正处于生成中（按钮为「停止生成」、
输入框为「继续输入以排队后续修改」排队态），`setValue` 写入被丢弃、草稿无法就位，
因此取消/占满两项未能实测。**下次在会话空闲时补验这三项即可。**

若按钮不出现（例如 ZCode 升级后），排查顺序：

1. `node repatch_asar.mjs --check` → 确认 marker 还在
2. 若丢失，完全退出 ZCode，跑 `node repatch_asar.mjs`，再打开
3. 页面里查 `window.__ZPE_BOOT__`（应有 port/token）与 `window.__zpeState()`（返回挂载态）
4. `window.__zpeState().placeError` 非空表示定位抛异常（0.3.0 起首次异常也会 `console.warn`）
5. `window.__zpeState().anchorVia` 不是 `cluster` 表示定位在降级运行

### 5.2 待办（按优先级）

| # | 待办 | 说明 |
|---|---|---|
| P0 | ~~0.3.x 真机重启验证~~ **重启已完成（2026-10-27）** | 0.3.1 已确认在跑（见 §5.1.1）。剩余为 3 项未覆盖的走查：`anchorVia`/`anchorDegraded`、取消复验、工具行占满 |
| P1 | 真实点击走查（部分完成） | `tools/sim-overlay.mjs` 已覆盖撤销/Esc/浅色/diff 卡位置共 4 项；真机已确认按钮存在。剩 3 项待空闲会话补验 |
| P2 | 上下文感知 | `core/context.mjs` 未写。`inject-main.cjs` 已预留 `context_enabled` 与 `payload.context` 透传，`prompt.mjs` 已有 `CONTEXT_SYSTEM_ADDITION` |
| P2 | 流式预览 | 目前进度只更新按钮 tooltip/aria-label，没有在草稿区做流式预览（避免与用户编辑打架） |
| P2 | 插件化双轨 | 用官方 hooks 做「提交时增强」兜底（`UserPromptSubmit` 只有 `additionalContext`，无法原地回填）。任务书 §5.B。**等外部依赖**：ZCode 官方 hooks 能力 |
| P2 | 构建期拆分 | 单文件 + diff 双份维护（`core/diff.mjs` 与 overlay 内副本，由 `test/overlay-diff.test.mjs` 强制一致）。任务书 §5.C |
| P3 | 设置面板 | 目前只能改 `config.json`。Manifest `userConfig` 的 `sensitive` 项在 ZCode 里无法输入/持久化。**受阻于宿主能力** |
| P3 | 升级检测提示 | 增加「检测到 ZCode 版本变化 → 提示重跑 repatch」的启动检查 |
| P4 | `/enhance` 兜底命令 | E 失效期间可用：一个 skill + command，结果落对话 |

### 5.3 已验证的结论（含真机）

**v0.3.0（2026-10-26，stdio 级）**

| 验证项 | 工具 | 结果 |
|---|---|---|
| 单元测试 | `npm test` | **140 项全过**（基线 118 + 新增 22） |
| 注入前静态体检 | `tools/preflight.mjs` | ALL PASS |
| core 导入 | `tools/check-core-url.mjs` | 4 个模块全 OK（含新增 `core/trust.mjs`） |
| 浮层完整交互链路 | `tools/sim-overlay.mjs` | ALL PASS（含 rAF 停摆、定位缓存、主题/无障碍/Esc 断言） |
| 桥接层（真实模型） | `tools/bridge-selftest.mjs` | ALL PASS（含 Host 校验、`configShape`、真实调用 3.5–5.2s） |
| retryable 一致性 | `node -e "…describeError…"` | `invalid-credential → false`，与 core 表一致 |
| **0.3.1 真机重启验证** | 进程启动时间 + 文件 atime + 桥端口 | **已通过（2026-10-27）**：pid 10676 于 11:35:56 启动，`core/trust.mjs`（0.2.0 无此文件）11:37:40 被读取，桥接监听 `127.0.0.1:63619` |
| **0.3.1 真机点击走查（部分）** | 主窗口可访问性树 | **按钮存在**（`kind=button` / `title="请先输入需要增强的提示词"` / `AXPress`），紧邻 token 计量之后；撤销/Esc/浅色/diff 卡位置由 `sim-overlay.mjs` ALL PASS 覆盖 |

**v0.1.0 / v0.2.0（历史真机结论）**

| 验证项 | 工具 | 结果 |
|---|---|---|
| 真实模型输出质量 | `tools/e2e-model.mjs` | 中英文各一，六段式完整、语言一致 |
| patched asar 可加载 | `tools/check-asar-loadable.mjs` | 全过 |
| **真机点击（端到端）** | 用户操作 + 截图 | **通过**（见 §4.2） |
| **真机 DOM 断言** | `tools/peek.mjs` | 全部 `issues: none` |
| **真机回读一致性** | `tools/verify-writedraft.mjs` | `lexMatch: true`（159 字多行样本） |
| 多行草稿往返 | `tools/check-multiline.mjs` | 全过 |

#### 5.3.1 探针使用的注意事项（重要）

调试用的探针是通过**状态栏项目 `overlay.js` 的 mtime 热更新通道**注入的。每次往该文件追加/改写内容，
都会触发状态栏 overlay 重新注入执行，**连带把我的浮层实例也重置**（撤销栈清空、diff 卡关闭）。

因此：
- 调试探针**只用于一次性取证**，用完立即把追加的探针块从状态栏 `overlay.js` 里删掉
  （按成段注释删除，不要整份还原备份 —— 运行期间状态栏项目自己也可能更新该文件）；
- 不要用探针去读取"用户刚点完的浮层状态" —— 探针自己会把那个状态清掉；
- 验证功能请直接看界面，或用 `tools/peek.mjs` 做单次只读取证。

### 5.4 已知限制（非缺陷，是设计取舍）

1. **跟随会话模型依赖读 DOM** —— 当前选中的模型存在 React 内部 state 里，渲染端读不到，
   只能从工具行按钮的 `aria-label` 反推。界面结构变化会导致读不到，此时回落到默认模型
   （功能仍可用，只是不再跟随）。这是「尽力跟随 + 安全回落」，不是精确同步。
2. **每次 ZCode 升级注入丢失** —— 客户端整份替换 asar。这是 asar 方案的固有代价。
3. **多窗口**：每个窗口都注入，各自独立，共用同一个桥与同一套闸门（限流是全局的）。
   不同窗口的会话模型可能不同，各自随请求上报，互不影响。
4. **跟随成功时 `config.json` 的 provider/model 不生效** —— 它只是回落目标。
   想让增强固定用某个模型，需要把会话模型也切过去。

---

## 6. 关键避坑与运行约束

### 6.1 环境硬约束（来自用户 AGENTS.md，均已踩过）

- **禁止裸 `&` / `nohup` / `setsid`** 起后台常驻进程，用工具的 `run_in_background`。
- **单条 Bash 前台等待 ≤ 60 秒**；阻塞探测包超时。**超过 2 分钟无返回立即停**。
- **Bash 的 cwd 每条命令重置**，内联 `cd /d <dir> && ...`。
- **本机 shell 是 cmd.exe，不是 Git Bash**：没有 `ls` / `tail` / `timeout`（Windows 的 `timeout`
  是 `TIMEOUT /T`，语义不同）、`grep` 要改用 `findstr`。
- **多行 `node -e` 在 cmd 下会静默失败**（无输出、退出码 0）。**一律改写成 `.mjs` 脚本文件再执行**，
  这是本轮最主要的效率损耗来源。
- **cmd 的引号转义会破坏正则**（`"` 与 `\` 交替转义）。含正则的校验一律进脚本文件。

### 6.2 服务启停（硬约束）

- 重启 / 关闭 ZCode **必须事先获得用户书面确认**，说明停机时长与是否自动拉起。
- 本轮**未获得确认**，因此只执行了 patch，**没有**动 ZCode 进程（当前进程仍在跑旧代码）。
- `repatch` / `uninstall` 都要求 ZCode 完全退出（虽然是"可写"状态，但进程在跑时替换 asar
  会让运行中的客户端读到错乱内容）。

### 6.3 本项目专属陷阱

| # | 陷阱 | 规避 |
|---|---|---|
| 1 | **`execCommand` 写入是单行道** | 只用 `setEditorState`；已加静态测试禁止 `execCommand('insertText')` |
| 2 | **`String(Uint8Array)` 得到字节列表** | 一律 `TextDecoder`；已加单测 |
| 3 | **写入"看着变了但发的是旧的"** | 写完必须回读 DOM + editor state 双比对，不一致即报错 |
| 4 | **`parseEditorState` 的结构不对会抛** | `buildState` 里 root/paragraph/text 的字段按 Lexical 规范逐项填；`textFormat`/`textStyle` 不能省 |
| 5 | **不能碰卡片 `marginBottom`** | 那是状态栏的让位边距；静态测试守住 |
| 6 | **不能插 React 管理的 DOM 子树** | 浮层只挂 `body` |
| 7 | **`elementFromPoint` 被 `pointer-events:none` 穿透** | 命中 `body`/`html` 视为被遮挡 |
| 8 | **自己的浮层会触发"隐藏→复显"循环** | 遮挡判定豁免 `#zpe-*` |
| 9 | **`role="dialog"` 内的 contenteditable 不是聊天输入框** | `closest('[role="dialog"]')` 排除 |
| 10 | **超时只停等待，上游还在计费** | 必须 `iterator.return()`；已加单测断言 `closed === true` |
| 11 | **`providerConfigRules.providerRules` 是内部格式** | 解析失败返回 null 并降级置灰，绝不崩 |
| 12 | **热更新先校验语法** | `new Function(src)` 不过就跳过，防半截文件污染页面 |
| 13 | **渲染端没有 `nodeIntegration`** | 拿不到 `ipcRenderer`，所以用本地 HTTP 桥 |
| 14 | **写文件到工作区会被 MCP 拒** | 用工具返回的 artifacts 路径再 `cp` |
| 15 | **`innerText` 与 editor state 不是等价表示** | Lexical 用 `<p>` 渲染，`innerText` 在段落间多一个换行。判等一律用 editor state |
| 16 | **窗口隐藏时 rAF 会被暂停** | 定位循环必须有 `setInterval` 兜底，否则切后台再回来按钮就死了 |
| 17 | **探针会重置浮层状态** | 状态栏 `overlay.js` 热更新会重建浮层实例，探针只用于一次性取证 |
| 18 | **矩形 mock 缺 `bottom`/`right` 字段会让重叠判定假绿** | 一律用 `top+height` / `left+width` 推导；直接读 `r.bottom` 得到 `undefined`，比较恒 false |
| 19 | **测试 mock 的选择器集合必须覆盖被测代码用到的全部选择器** | `anchor.test.mjs` 曾只支持 `"button"`，而 `findModelButton` 用 `"button, [role='button']"` → model 路径恒不可达 |
| 20 | **`FakeNode.style` 必须展开 `cssText`** | 否则 `style.display` 恒为空串，`display !== "none"` 判断全部假绿（sim 里 diff 卡"可见"断言一度形同虚设） |
| 21 | **`place()` 的异常只写 `state.placeError` 等于黑盒** | 0.3.0 起首次异常 `console.warn`；正是它暴露了 sim 里 `positionDiff` 每帧抛 `TypeError` 的旧空洞 |
| 22 | **`anchorFor`/`findModelButton` 的签名不能改** | 测试用正则从源码抠函数体再 `new Function` 求值，签名一变即崩 |
| 23 | **`anchorFor` 内不得调用 `closest()` / `style` / `offsetWidth`** | 该 mock 只提供 `getBoundingClientRect` + `getAttribute`，其它调用会 TypeError |
| 24 | **`cardOf` 绝不能返回 null** | `place()` 直接崩、按钮永久消失；无候选时 `return last` |
| 25 | **桥的 Host 校验必须用 `node:http` 验证，不能用 `fetch`** | undici 把 `Host` 当禁止修改的头，传了也会被忽略，断言等于没测 |
| 26 | **`web-contents-created` 时窗口还没有 URL** | 创建时只能按类型过滤，可信判定放在 `inject()` 内（URL 已就绪）；否则空 URL 被拒、钩子永不挂上（v0.3.0 真机事故） |

### 6.4 证据查证命令

```bash
# 注入状态
node repatch_asar.mjs --check
# asar 内两个 marker
node -e "const b=require('fs').readFileSync('E:/ZCode/resources/app.asar');console.log('ZPE',b.includes(Buffer.from('__ZPE_PATCH__')),'ZUSAGE',b.includes(Buffer.from('__ZUSAGE_PATCH__')))"
# 官方是否已接线增强功能（>0 = 本项目该退役了）
node -e "const s=require('fs').readFileSync('E:/ZCode/resources/app.asar').toString('latin1');console.log(s.split('enhancePrompt').length-1)"
# 本地模型代理存活
node -e "fetch('http://127.0.0.1:7863/v1/models').then(r=>console.log(r.status)).catch(e=>console.log('down',e.message))"
```

---

## 7. 下一步接手请从这里开始

1. ~~重启 ZCode 做真实点击走查~~ **重启已完成（2026-10-27，0.3.1 在跑）**；
   只剩 3 项待补验，清单见 §5.1.1 末尾（`anchorVia`/`anchorDegraded`、取消复验、工具行占满）；
2. 若按钮没出现，按 §5.1.1 的 5 步排查；
3. 若出现 `readback-mismatch`，查**§6 的「已知坑」第 2 条**（多行草稿的 Lexical 结构 —
   `innerText` 在 `<p>` 段落间多一个换行，校验基准已改为 editor state）；
4. 三项补验通过后再推进 P2 的上下文感知（`core/context.mjs`，接口已预留）。
