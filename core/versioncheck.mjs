/**
 * ZCode 宿主版本变化检测（P3 升级检测提示）。
 *
 * 背景：ZCode 每次升级都会整份替换 app.asar，注入随之丢失（历史已发生两次：
 * 迁移到 E:\ZCode、2026-10-29 升级 3.17.1），症状是 ✨ 按钮静默消失。
 *
 * 机制：loader 在宿主主进程启动时读 app.getVersion()，与状态文件里上次记录的
 * 版本比较（inject-main.cjs 启动块负责读写与提示）。判定逻辑集中在本模块，
 * 纯函数、零运行时依赖，test/versioncheck.test.mjs 覆盖全部分支。
 *
 * 边界说明（重要）：本检查在 loader 内运行时，注入必然存活（loader 能跑 =
 * asar 里的注入行还在）。所以「版本变化且注入丢失」的 warn-repatch 分支在
 * loader 内不可达 —— 它供外部工具/未来检查脚本复用。loader 内可达的真实场景：
 *   1) 升级未替换 asar（安装器行为变化）或有人手工恢复过注入行 → 提示 --check 复核；
 *   2) 每次成功启动都落一条版本记录，外部工具可据此回答「上次注入在哪个宿主版本」。
 */

import fs from "node:fs";

/** 状态文件结构版本，未来字段演进时用于迁移判断。 */
export const HOST_STATE_VERSION = 1;

/**
 * 判定宿主版本变化后的处置建议。
 *
 * @param {{lastSeen?:string|null, current?:string|null, patched?:boolean}} input
 * @returns {{changed:boolean, action:"none"|"record"|"warn-recheck"|"warn-repatch", zh:string}}
 *   action 语义：
 *     none         —— 版本没变（或拿不到当前版本），什么都不做
 *     record       —— 首次记录（状态文件为空/损坏），安静落盘，不打扰用户
 *     warn-recheck —— 版本变了且注入仍在：提示 --check 复核
 *     warn-repatch —— 版本变了且注入已丢：提示完整退出后重跑 repatch（loader 内不可达）
 */
export function evaluateHostVersion({ lastSeen, current, patched = true } = {}) {
  const cur = String(current ?? "").trim();
  if (cur === "") return { changed: false, action: "none", zh: "" };
  const prev = String(lastSeen ?? "").trim();
  if (prev === "") return { changed: false, action: "record", zh: "" };
  if (prev === cur) return { changed: false, action: "none", zh: "" };
  if (patched) {
    return {
      changed: true,
      action: "warn-recheck",
      zh:
        "检测到 ZCode 版本变化：" + prev + " → " + cur + "。注入行仍存活，但升级可能替换过 asar。" +
        "请运行 node repatch_asar.mjs --check 复核（输出 NOT_PATCHED = 需重新注入）。",
    };
  }
  return {
    changed: true,
    action: "warn-repatch",
    zh:
      "检测到 ZCode 版本变化：" + prev + " → " + cur + "，且注入已丢失。" +
      "请完全退出 ZCode（托盘 Quit）后运行 node repatch_asar.mjs 重新注入。",
  };
}

/**
 * 读宿主版本状态文件。
 * @param {string} file 绝对路径
 * @returns {{ok:boolean, state:{lastSeenVersion:string, updatedAt:string, schema:number}|null, error:string}}
 *   文件缺失 / JSON 损坏 / 结构不符一律 ok:false（调用方按"无记录"处理）。
 */
export function readHostState(file) {
  let raw = "";
  try {
    raw = String(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, state: null, error: e && e.code === "ENOENT" ? "missing" : String((e && e.message) || e) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const lastSeenVersion = typeof parsed.lastSeenVersion === "string" ? parsed.lastSeenVersion : "";
    if (lastSeenVersion === "") throw new Error("lastSeenVersion missing");
    return {
      ok: true,
      state: {
        lastSeenVersion,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        schema: typeof parsed.schema === "number" ? parsed.schema : 0,
      },
      error: "",
    };
  } catch (e) {
    return { ok: false, state: null, error: "corrupt: " + String((e && e.message) || e) };
  }
}

/**
 * 写宿主版本状态文件（临时文件 + rename，半截写入不会污染旧记录）。
 * @param {string} file 绝对路径
 * @param {{lastSeenVersion:string}} state
 * @returns {{ok:boolean, error:string}}
 */
export function writeHostState(file, state) {
  const version = String((state && state.lastSeenVersion) ?? "").trim();
  if (version === "") return { ok: false, error: "lastSeenVersion empty" };
  const body = JSON.stringify(
    { lastSeenVersion: version, updatedAt: new Date().toISOString(), schema: HOST_STATE_VERSION },
    null,
    2
  );
  const tmp = file + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, error: "" };
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return { ok: false, error: String((e && e.message) || e) };
  }
}
