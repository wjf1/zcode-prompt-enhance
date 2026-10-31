/**
 * core/versioncheck.mjs 单元测试（P3 升级检测提示）。
 *
 * 覆盖 evaluateHostVersion 全部分支 + 状态文件读写的健壮性，
 * 以及 inject-main.cjs 启动块的静态接线断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_STATE_VERSION,
  evaluateHostVersion,
  readHostState,
  writeHostState,
} from "../core/versioncheck.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- evaluateHostVersion ---------------- */

test("判定：拿不到当前版本 → none", () => {
  for (const cur of [undefined, null, "", "   "]) {
    const v = evaluateHostVersion({ lastSeen: "3.17.1", current: cur });
    assert.deepEqual(v, { changed: false, action: "none", zh: "" });
  }
});

test("判定：首次记录（无 lastSeen）→ record，不打扰", () => {
  for (const lastSeen of [undefined, null, "", "   "]) {
    const v = evaluateHostVersion({ lastSeen, current: "3.17.1" });
    assert.equal(v.action, "record");
    assert.equal(v.changed, false);
    assert.equal(v.zh, "");
  }
});

test("判定：版本相同 → none", () => {
  const v = evaluateHostVersion({ lastSeen: "3.17.1", current: " 3.17.1 " });
  assert.equal(v.action, "none");
  assert.equal(v.changed, false);
});

test("判定：版本变化且注入存活 → warn-recheck，提示 --check 复核", () => {
  const v = evaluateHostVersion({ lastSeen: "3.16.2", current: "3.17.1", patched: true });
  assert.equal(v.changed, true);
  assert.equal(v.action, "warn-recheck");
  assert.ok(v.zh.includes("3.16.2"), "提示应包含旧版本");
  assert.ok(v.zh.includes("3.17.1"), "提示应包含新版本");
  assert.ok(v.zh.includes("repatch_asar.mjs --check"), "提示应指到 --check 命令");
});

test("判定：版本变化且注入丢失 → warn-repatch（外部工具分支）", () => {
  const v = evaluateHostVersion({ lastSeen: "3.16.2", current: "3.17.1", patched: false });
  assert.equal(v.action, "warn-repatch");
  assert.ok(v.zh.includes("重新注入"));
  assert.ok(v.zh.includes("完全退出"));
});

test("判定：patched 缺省按存活处理（loader 内注入必然在）", () => {
  assert.equal(evaluateHostVersion({ lastSeen: "1", current: "2" }).action, "warn-recheck");
});

test("判定：入参整体缺省不抛", () => {
  assert.doesNotThrow(() => evaluateHostVersion());
  assert.equal(evaluateHostVersion().action, "none");
});

/* ---------------- 状态文件读写 ---------------- */

function tmpFile() {
  return path.join(os.tmpdir(), "zpe-versioncheck-" + process.pid + "-" + Math.random().toString(36).slice(2));
}

test("状态文件：不存在 → ok:false(missing)，调用方按无记录处理", () => {
  const r = readHostState(tmpFile());
  assert.equal(r.ok, false);
  assert.equal(r.error, "missing");
  assert.equal(r.state, null);
});

test("状态文件：写入后读回一致，schema 为当前版本", () => {
  const f = tmpFile();
  try {
    const w = writeHostState(f, { lastSeenVersion: "3.17.1" });
    assert.equal(w.ok, true);
    const r = readHostState(f);
    assert.equal(r.ok, true);
    assert.equal(r.state.lastSeenVersion, "3.17.1");
    assert.equal(r.state.schema, HOST_STATE_VERSION);
    assert.ok(r.state.updatedAt !== "", "updatedAt 应有值");
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test("状态文件：覆盖写生效，不留临时文件", () => {
  const f = tmpFile();
  try {
    writeHostState(f, { lastSeenVersion: "3.16.2" });
    writeHostState(f, { lastSeenVersion: "3.17.1" });
    const r = readHostState(f);
    assert.equal(r.state.lastSeenVersion, "3.17.1");
    const leftovers = fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith(path.basename(f) + ".tmp-"));
    assert.deepEqual(leftovers, [], "临时文件应被 rename 消费掉");
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test("状态文件：JSON 损坏 / 结构不符 → ok:false(corrupt)", () => {
  const f1 = tmpFile();
  fs.writeFileSync(f1, "{ not json", "utf8");
  const f2 = tmpFile();
  fs.writeFileSync(f2, JSON.stringify({ foo: 1 }), "utf8");
  const f3 = tmpFile();
  fs.writeFileSync(f3, "[1,2]", "utf8");
  try {
    for (const [f, frag] of [[f1, "corrupt"], [f2, "corrupt"], [f3, "corrupt"]]) {
      const r = readHostState(f);
      assert.equal(r.ok, false, f);
      assert.ok(r.error.startsWith(frag), `error 应标记 corrupt：${r.error}`);
    }
  } finally {
    for (const f of [f1, f2, f3]) fs.rmSync(f, { force: true });
  }
});

test("状态文件：lastSeenVersion 为空串的写入被拒绝", () => {
  const w = writeHostState(tmpFile(), { lastSeenVersion: "" });
  assert.equal(w.ok, false);
  assert.ok(w.error.includes("empty"));
});

/* ---------------- inject-main.cjs 接线静态断言 ---------------- */

test("接线静态断言：启动块读 app.getVersion、状态文件被 gitignore、boot 载荷带 hostVersion", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "inject-main.cjs"), "utf8");
  assert.ok(src.includes("core/versioncheck.mjs"), "应动态引入 core/versioncheck.mjs");
  assert.ok(src.includes("app.getVersion()"), "应读取宿主 app.getVersion()");
  assert.ok(src.includes(".zpe-host-state.json"), "应使用状态文件记录上次版本");
  assert.ok(src.includes("hostVersionChanged"), "boot 载荷应携带 hostVersionChanged");
  const gitignore = fs.readFileSync(path.join(HERE, "..", ".gitignore"), "utf8");
  assert.ok(gitignore.includes(".zpe-host-state.json"), "状态文件应被 gitignore");
});
