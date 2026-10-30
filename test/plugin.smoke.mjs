// 墨忆插件级冒烟测试：mock ctx 走通 apply() 的全部接线（注册/事件/注入/三工具/面板 API 路由）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { apply } from "../index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ink-smoke-"));

const listeners = new Map();
const tools = new Map();
const sections = [];
const routes = new Map();
let effectCleanups = [];

const services = {
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name); } },
  systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
  webServer: { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } },
};

const ctx = {
  ...services,
  logger: console,
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
    return () => { listeners.set(name, listeners.get(name).filter(f => f !== fn)); };
  },
  emit(name, payload) { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload); },
  effect(fn) { const d = fn(); if (typeof d === "function") effectCleanups.push(d); return () => {}; },
  get() { return undefined; }, // llm/sessionQuery 缺席：自动蒸馏应静默跳过
  agents: { list: () => [] },
  sessions: {},
};

// 热安装场景：apply 时已有存活 agent，应补挂注入段
const preAgent = { id: "sess-pre", ctx };
ctx.agents.list = () => [preAgent];

apply(ctx, { homeDir: path.join(tmp, "data"), extractEveryTurns: 1 });
assert.equal(sections.length, 1, "已存活 agent 应补挂注入段");

// ---- 模拟一个 agent 生命周期 ----
const agent = { id: "sess-42", ctx }; // agent.ctx 复用同一 mock（scoped.on 会再走一遍全局表）
ctx.emit("agent/created", { agent });
assert.equal(sections.length, 2, "新建 agent 再挂一个注入段（共 2）");
assert.equal(tools.size, 3, "应注册 3 个工具");

// 无记忆时注入为空
assert.equal(sections[1].text({ scope: agent }), "", "空库不注入");

// 记录一条
const remember = tools.get("ink_remember");
const r1 = await remember.execute(
  { text: "用户偏好中文回复，key 用语言偏好", category: "user", key: "用户.语言偏好", durable: true },
  { agent },
);
assert.ok(r1.id, "remember 应返回 id");

// 近似重复 → 合并而不是新增
const r2 = await remember.execute(
  { text: "用户偏好中文回复，语言偏好为中文", category: "user", key: "用户.语言偏好", durable: true },
  { agent },
);
assert.equal(r2.deduped, true, "近似重复应去重合并");

// 同键取代（不同内容、同 key）
const r3 = await remember.execute(
  { text: "用户现在更喜欢中英混合的技术术语", category: "user", key: "用户.语言偏好" },
  { agent },
);
assert.ok(Array.isArray(r3.superseded) && r3.superseded.length >= 1, "同键应取代旧条目");

// 会话话题 → 注入应命中
ctx.emit("agent/inbox/inserted", { message: { content: [{ type: "text", text: "中英混合的技术术语这个事，用中文说" }] } });
const injected = sections[1].text({ scope: agent });
assert.ok(injected.includes("<ink_memory>"), "注入块应出现");
assert.ok(injected.includes("中英混合"), "注入应包含现行记忆");
assert.ok(!injected.includes("用户偏好中文回复"), "被取代的旧条目不应出现");

// ink_search 检索
const search = tools.get("ink_search");
const sres = await search.execute({ query: "中英混合 术语" }, { agent });
assert.ok(sres.results.length >= 1, "检索应有命中");

// ink_manage：status 观测面
const manage = tools.get("ink_manage");
const status = await manage.execute({ action: "status" }, { agent });
assert.ok(status.store.active >= 1, "status 应见活跃条数");
assert.ok(Array.isArray(status.lastRecalls) && status.lastRecalls.length >= 1, "status 应含注入日志（观测面）");
assert.ok(status.lastRecalls[0].hits.length >= 1, "注入日志应记录命中条目");

// list / forget / reinstate / disable
const listed = await manage.execute({ action: "list" }, { agent });
assert.ok(listed.items.some(i => i.state === "superseded-by:ink-" + r3.id.slice(4) || i.state.startsWith("superseded")), "list 应显示取代态");
const target = listed.items.find(i => i.text.includes("中英混合"));
const f = await manage.execute({ action: "forget", id: target.id }, { agent });
assert.equal(f.forgotten, true);
assert.ok(!sections[1].text({ scope: agent }).includes("中英混合"), "forget 后不再注入");
await manage.execute({ action: "reinstate", id: target.id }, { agent });

// 会话关闭注入 → 注入应为空
await manage.execute({ action: "disable" }, { agent });
assert.equal(sections[1].text({ scope: agent }), "", "disable 后不注入");
await manage.execute({ action: "enable" }, { agent });

// ---- 面板 API 路由：与工具共享同一操作层 ----
assert.equal(routes.size, 11, "应注册 11 条 /api/ink-memory 路由");

function fakeRes() {
  const res = { statusCode: 0, body: "", writeHead(s) { res.statusCode = s; }, end(b) { res.body = b; } };
  return res;
}
async function callGet(p) {
  const h = routes.get(p.split("?")[0]);
  assert.ok(h, "路由存在：" + p);
  const res = fakeRes();
  await h({ method: "GET", url: p }, res);
  return { code: res.statusCode, data: JSON.parse(res.body) };
}
async function callPost(p, body) {
  const h = routes.get(p);
  assert.ok(h, "路由存在：" + p);
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  const res = fakeRes();
  await h(req, res);
  return { code: res.statusCode, data: JSON.parse(res.body) };
}

const st = await callGet("/api/ink-memory/status");
assert.equal(st.code, 200);
assert.ok(st.data.store.active >= 1 && st.data.config.halfLifeDays === 30, "status 路由");

const lt = await callGet("/api/ink-memory/list?q=&all=0");
assert.ok(lt.data.items.some(i => i.text.includes("中英混合")), "list 路由应见现行记忆");

const se = await callGet("/api/ink-memory/search?q=" + encodeURIComponent("中英混合 术语"));
assert.ok(se.data.results.length >= 1 && se.data.results[0].freshness > 0, "search 路由带分数");

const added = await callPost("/api/ink-memory/remember", { text: "面板记录的项目约定：墨忆面板放设置页", category: "project", key: "墨忆.面板" });
assert.equal(added.code, 200);
assert.ok(added.data.id, "remember 路由");
const pid = added.data.id;

const pinned = await callPost("/api/ink-memory/pin", { id: pid, durable: true });
assert.equal(pinned.data.durable, true);
const unpin = await callPost("/api/ink-memory/pin", { id: pid, durable: false });
assert.equal(unpin.data.durable, false, "面板可取消钉（工具 pin 只钉不摘）");

const upd = await callPost("/api/ink-memory/update", { id: pid, text: "改写过的项目约定：面板在设置页" });
assert.equal(upd.data.updated, true);
const lt2 = await callGet("/api/ink-memory/list?q=" + encodeURIComponent("改写过"));
assert.ok(lt2.data.items.some(i => i.text.includes("改写过")), "update 生效于 list");

await callPost("/api/ink-memory/forget", { id: pid });
const lt3 = await callGet("/api/ink-memory/list?q=&all=0");
assert.ok(!lt3.data.items.some(i => i.id === pid), "forget 后 active 列表消失");
await callPost("/api/ink-memory/reinstate", { id: pid });
const lt4 = await callGet("/api/ink-memory/list?q=&all=0");
assert.ok(lt4.data.items.some(i => i.id === pid), "reinstate 恢复");
await callPost("/api/ink-memory/delete", { id: pid });
const lt5 = await callGet("/api/ink-memory/list?q=&all=1");
assert.ok(!lt5.data.items.some(i => i.id === pid), "delete 彻底移除");

const sw = await callPost("/api/ink-memory/session", { session: "sess-x", enabled: false });
assert.equal(sw.data["sess-x"], false);
const st2 = await callGet("/api/ink-memory/status");
assert.equal(st2.data.sessionFlags["sess-x"].enabled, false, "session 开关入 status");
await callPost("/api/ink-memory/session", { session: "sess-x", enabled: null });
const st3 = await callGet("/api/ink-memory/status");
assert.ok(!("sess-x" in st3.data.sessionFlags), "enabled:null 重置回默认");

const bad = await callPost("/api/ink-memory/forget", { id: "ink-nope" });
assert.equal(bad.code, 400);
assert.ok(bad.data.error, "错误带原因");

// 轮末蒸馏（无 llm）应安静跳过
ctx.emit("agent/turn-stopping", { agent, turn: 1 });
await new Promise(r => setTimeout(r, 50));

// agent 销毁 → 清理后再收事件不应崩
ctx.emit("agent/disposed", { agent });
ctx.emit("agent/turn-stopping", { agent, turn: 2 });

// 卸载清理
for (const d of effectCleanups) d();
assert.equal(routes.size, 0, "卸载后路由应全部注销");
await new Promise(r => setTimeout(r, 50));
assert.ok(fs.existsSync(path.join(tmp, "data", "store.json")), "卸载前应已落盘");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ink plugin smoke: all passed");
