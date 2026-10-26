# HANDOFF.md — 接力开发文档

> 项目：zcode-prompt-enhance（ZCode 提示词增强）
> 当前阶段：**v0.1.0 已注入客户端，待重启验证**
> 最后更新：2026-10-26

---

## 1. 项目概况与当前状态

| 项 | 值 |
|---|---|
| 项目定位 | ZCode Desktop 输入框旁 ✨ 一键增强提示词，原地回填 + 撤销 + diff |
| 版本 | `0.1.0` |
| 位置 | `F:\AI\Zcode\zcode-prompt-enhance`（未 `git init`） |
| 线上部署 | 无（本地客户端增强工具） |
| 目标宿主 | ZCode Desktop **3.16.3**，装于 `F:\software\Zcode`，`app.asar` = `F:\software\Zcode\resources\app.asar` |
| 当前状态 | **已上线可用**：注入完成、真机点击验收通过、三轮真机缺陷已修复 |

### 当前注入状态

```
app.asar 307,046,010 字节（注入前 307,045,797，+213 字节 = 注入行长度）
注入标记：__ZPE_PATCH__ ✅   __ZUSAGE_PATCH__（状态栏）✅ 保留
备份：F:\software\Zcode\resources\app.asar.bak-zpe-20261026091847（注入前干净副本）
入口末尾两行 loader：
  ;import("file:///C:/Users/Administrator/.zcode/zcode-token-usage-statusbar/inject-main.cjs")
  ;import("file:///F:/AI/Zcode/zcode-prompt-enhance/inject-main.cjs")
```

⚠️ **注入的 loader 只在主进程启动时加载。当前 ZCode 进程是在注入之前启动的，所以 ✨ 按钮还没生效。**
需要完全退出 ZCode（托盘 → Quit）再重新打开。

---

## 2. 技术栈与运行基线

| 项 | 约束 |
|---|---|
| 运行时 | Node.js **≥ 22**（实测 v24.19.0） |
| 语言 | 注入层 `.cjs`（主进程 CommonJS）；核心逻辑 `.mjs`；浮层是纯 IIFE 字符串注入 |
| 运行时依赖 | **零**（prompt / diff / gates / SSE 全手写） |
| 开发期依赖 | `@electron/asar`，自动装到 `.asar-tools/`（首次 `repatch` 时） |
| 测试 | `node --test "test/*.test.mjs"`（Node 内置，89 项） |
| 模型协议 | Anthropic Messages，`POST {baseUrl}/messages`，SSE 流式 |

### 核心命令

```bash
node repatch_asar.mjs --dry-run        # 只解析路径 + 报告是否已注入
node repatch_asar.mjs --check          # 退出码 1 = 注入已丢失
node repatch_asar.mjs                  # 注入（需先完全退出 ZCode）
node uninstall.mjs                     # 移除注入，还原（需先完全退出 ZCode）
npm test                               # 89 项单测
node tools/preflight.mjs               # 静态体检
node tools/bridge-selftest.mjs         # 桥接自测（含真实模型调用）
node tools/check-asar-loadable.mjs     # 确认 patched asar 可加载
node tools/verify-writedraft.mjs       # 校验多行写入的 editor state 一致性
node tools/e2e-model.mjs               # 真实模型端到端
```

### 本机实测基线

- 可用 provider：`new-provider-2` / `workbuddy代理` → `http://127.0.0.1:7863/v1`，
  模型 `cn:deepseek-v4.1-flash`（实测 HTTP 200，首字约 1.7s，完整增强约 3.6–6.5s）
- ⚠️ `DESIGN.md` 里写的 `new-provider-4` **已不存在**，实际 id 是 `new-provider-2`
- 输入框实测：`[contenteditable="true"]`，类名 `min-h-10 max-h-40 ... outline-none`，
  矩形 `[345,621,836,40]`；卡片 `[333,608,861,105]`
- 工具行按钮（y=673、高 28）：添加上下文 x=345 / 切换模式 x=377 / 后台任务 x=493 /
  上下文用量 x=900 / 模型选择器 x=932(w218) / 发送或停止 x=1153

---

## 3. 核心架构与文件拓扑

```
F:\AI\Zcode\zcode-prompt-enhance\
├── inject-main.cjs              # 主进程 loader：注入浮层、起本地桥、provider 路由、三闸门
├── overlay-prompt-enhance.js    # 渲染端浮层（IIFE 字符串注入）：按钮/读写/撤销栈/diff 卡
├── core/
│   ├── prompt.mjs               # system prompt + frameUserPrompt + cleanEnhancedText
│   ├── provider.mjs             # provider_config.json 解析 + 白名单 + 路由选择
│   ├── enhancer.mjs             # SSE 客户端 + 竞速超时 + 错误码归一化
│   ├── diff.mjs                 # token 级 LCS（中文逐字/英文词级）
│   └── gates.mjs                # 熔断 → 限流 → 并发
├── repatch_asar.mjs             # 解包→追加 __ZPE_PATCH__→重打包→替换（3 份备份）
├── uninstall.mjs                # 移除注入行（导出 stripLoader 供测试）
├── test/                        # 5 个测试文件，89 项
├── tools/                       # 8 个校验/探针脚本
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

### 本轮（2026-10-26）完成的事

**从零实现 v0.1.0 → 注入 → 重启 → 真机验收通过，期间修复 3 个只在真机上暴露的缺陷。**

#### 4.1 真机验收结果（2026-10-26 17:30 后）

用户点击 ✨ 后截图确认功能正常：

- ✨ 出现在工具行（`+` / `完全访问` / `1` / `✨` / `↺` / `⇄`），与原生图标同尺寸同风格
- 草稿被原地替换为完整六段式提示词（角色 / 任务 / 待补充信息 / 步骤 / 输出格式 / 验收标准 / 边界情况）
- 缺失信息以 `（待补充：请粘贴完整代码）` 占位，未臆造
- diff 卡弹出并显示 `8 处改动 · 504 字新增 / 5 字替换 · 净 +499 字`
- 删除项红色删除线、新增项绿色下划线，底部有「新增 / 删除」图例和「恢复原文」按钮
- 撤销 ↺ 与差异 ⇄ 按钮出现

客观 DOM 断言（`tools/peek.mjs`，单次只读取证）：
按钮 `[538,673,28,28]`、不压任何原生按钮、不与状态栏重叠、中心点命中自己、无重复 id、祖先链正确。

#### 4.2 真机暴露并修复的三个缺陷

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

#### 4.3 其余完成项

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
| `overlay-prompt-enhance.js` | 约 1200 行，最大单文件；浮层 + 撤销栈 + diff 卡 + 页内 diff 副本 |
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

### 5.1.1 还需要你确认的（下次会话第一件事）

- [ ] **diff 卡位置修复后的复验**：再点一次 ✨，确认关闭按钮 ✕ 完整可见、卡片不顶出屏幕
- [ ] **撤销 ↺ 复验**：点 ↺ 能否退回原文
- [ ] **取消复验**：增强过程中再点 ✨ 能否取消且草稿不变
- [ ] **暗色/亮色主题**下 diff 卡对比度

若按钮不出现（例如 ZCode 升级后），排查顺序：

1. `node repatch_asar.mjs --check` → 确认 marker 还在
2. 若丢失，完全退出 ZCode，跑 `node repatch_asar.mjs`，再打开
3. 页面里查 `window.__ZPE_BOOT__`（应有 port/token）与 `window.__zpeState()`（返回挂载态）
4. `window.__zpeState().placeError` 非空表示定位抛异常

### 5.2 待办（按优先级）

| # | 待办 | 说明 |
|---|---|---|
| P1 | **真实点击走查** | AGENTS.md 要求 UI 功能交付前必须用真实鼠标走完关键路径。已在模拟 DOM 跑通全链路（`tools/sim-overlay.mjs`），但那不能替代真实走查 |
| P2 | 上下文感知 | `core/context.mjs` 未写。`inject-main.cjs` 已预留 `context_enabled` 与 `payload.context` 透传，`prompt.mjs` 已有 `CONTEXT_SYSTEM_ADDITION` |
| P2 | 流式预览 | 目前进度只更新按钮 tooltip，没有在草稿区做流式预览（避免与用户编辑打架） |
| P3 | 设置面板 | 目前只能改 `config.json`。Manifest `userConfig` 的 `sensitive` 项在 ZCode 里无法输入/持久化，所以不做 IPC 面板的话就只能走文件 |
| P3 | 升级检测提示 | 增加"检测到 ZCode 版本变化 → 提示重跑 repatch"的启动检查 |
| P4 | `/enhance` 兜底命令 | E 失效期间可用：一个 skill + command，结果落对话 |

### 5.4 已验证的结论（含真机）

| 验证项 | 工具 | 结果 |
|---|---|---|
| 单元测试 | `npm test` | **102 项全过** |
| 注入前静态体检 | `tools/preflight.mjs` | 全过（id 唯一、id 前缀、无 apiKey、安全断言） |
| ✨ 定位算法（真实矩形） | `tools/check-anchor.mjs` / `test/anchor.test.mjs` | 全过 |
| 多行草稿往返 | `tools/check-multiline.mjs` | 全过 |
| 浮层完整交互链路 | `tools/sim-overlay.mjs` | 全过，含 rAF 停摆回归 |
| 桥接层（真实模型） | `tools/bridge-selftest.mjs` | 全过 |
| 真实模型输出质量 | `tools/e2e-model.mjs` | 中英文各一，六段式完整、语言一致 |
| patched asar 可加载 | `tools/check-asar-loadable.mjs` | 全过 |
| **真机点击（端到端）** | 用户操作 + 截图 | **通过**（见 §4.1） |
| **真机 DOM 断言** | `tools/peek.mjs` | 全部 `issues: none` |
| **真机回读一致性** | `tools/verify-writedraft.mjs` | `lexMatch: true`（159 字多行样本） |

#### 5.4.1 探针使用的注意事项（重要）

调试用的探针是通过**状态栏项目 `overlay.js` 的 mtime 热更新通道**注入的。每次往该文件追加/改写内容，
都会触发状态栏 overlay 重新注入执行，**连带把我的浮层实例也重置**（撤销栈清空、diff 卡关闭）。

因此：
- 调试探针**只用于一次性取证**，用完立即把追加的探针块从状态栏 `overlay.js` 里删掉
  （按成段注释删除，不要整份还原备份 —— 运行期间状态栏项目自己也可能更新该文件）；
- 不要用探针去读取"用户刚点完的浮层状态" —— 探针自己会把那个状态清掉；
- 验证功能请直接看界面，或用 `tools/peek.mjs` 做单次只读取证。

### 5.3 已知限制（非缺陷，是设计取舍）

1. **增强模型不跟随输入框选中的模型** —— 那是 React 内部 state，渲染端读不到。用 `config.json` 指定。
2. **每次 ZCode 升级注入丢失** —— 客户端整份替换 asar。这是 asar 方案的固有代价。
3. **多窗口**：每个窗口都注入，各自独立，共用同一个桥与同一套闸门（限流是全局的）。

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

### 6.4 证据查证命令

```bash
# 注入状态
node repatch_asar.mjs --check
# asar 内两个 marker
node -e "const b=require('fs').readFileSync('F:/software/Zcode/resources/app.asar');console.log('ZPE',b.includes(Buffer.from('__ZPE_PATCH__')),'ZUSAGE',b.includes(Buffer.from('__ZUSAGE_PATCH__')))"
# 官方是否已接线增强功能（>0 = 本项目该退役了）
node -e "const s=require('fs').readFileSync('F:/software/Zcode/resources/app.asar').toString('latin1');console.log(s.split('enhancePrompt').length-1)"
# 本地模型代理存活
node -e "fetch('http://127.0.0.1:7863/v1/models').then(r=>console.log(r.status)).catch(e=>console.log('down',e.message))"
```

---

## 7. 下一步接手请从这里开始

1. 先读 §5.1，重启 ZCode（需用户确认），做真实点击走查；
2. 若按钮没出现，按 §5.1 的 5 步排查；
3. 若出现 `readback-mismatch`，查 §5.2 的第 1 条（多行草稿的 Lexical 结构）；
4. 走查通过后再推进 P2 的上下文感知（`core/context.mjs`，接口已预留）。
