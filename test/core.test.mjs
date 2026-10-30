// 墨忆核心离线单测：不依赖 cordis，只测 lib 层（分词/BM25/衰减/存储语义）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tokenize, similarity, tokenSet, Bm25, freshness, dayLabel } from "../lib/text.js";
import { InkStore } from "../lib/store.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ink-test-"));

// ---- 分词：中文 bigram、英文词、虚词噪声 ----
const t1 = tokenize("她偏好中文回复");
assert.ok(t1.includes("偏好") && t1.includes("中文"), "CJK bigram 应命中 偏好/中文");
const t2 = tokenize("remember the API key rule");
assert.ok(t2.includes("remember") && t2.includes("api") && t2.includes("rule"), "英文词切分");
assert.equal(tokenize("我的了是在").length, 0, "纯虚词串应被过滤为空");
assert.deepEqual(tokenize(null), []);

// ---- 相似度：同义改写 vs 无关 ----
const a = tokenSet("用户常驻杭州，习惯亚洲时区协作");
const b = tokenSet("用户住在杭州，长期按亚洲时区工作");
const c = tokenSet("服务器部署在腾讯云新加坡区域");
assert.ok(similarity(a, b) > 0.2, `改写相似应 >0.2，实际 ${similarity(a, b)}`);
assert.ok(similarity(a, c) < similarity(a, b), "无关文本相似度应更低");

// ---- BM25：稀有词得分更高 ----
const bm = new Bm25();
bm.add("x1", tokenize("项目代号墨忆使用插件架构"));
bm.add("x2", tokenize("她喜欢用中文交流"));
bm.add("x3", tokenize("墨忆插件的召回使用墨忆术语"));
bm.finish();
const s = bm.search(tokenize("墨忆插件"));
assert.ok((s.get("x3") ?? 0) > (s.get("x1") ?? 0), "词频高者 BM25 更高");
assert.ok(!s.has("x2"), "未命中词不应得分");

// ---- 衰减：半衰期语义 ----
const now = Date.parse("2026-10-24T00:00:00Z");
assert.equal(freshness(now, now, 30, false), 1);
assert.ok(Math.abs(freshness(now - 30 * 86_400_000, now, 30, false) - 0.5) < 1e-9, "30 天=0.5");
assert.equal(freshness(now - 365 * 86_400_000, now, 30, true), 1, "durable 不衰减");
assert.ok(freshness(NaN, now, 30, false) >= 0, "异常输入不产生 NaN 崩溃路径");

// ---- dayLabel ----
assert.equal(dayLabel("2026-10-02T00:00:00Z", "2026-11-01T00:00:00Z"), "10-02");
assert.equal(dayLabel("2025-10-02T00:00:00Z", "2026-11-01T00:00:00Z"), "2025-10-02");

// ---- 存储：原子落盘 + 重载 + 同键取代 + 损坏隔离 ----
{
  const dir = path.join(tmp, "store1");
  const st = new InkStore(dir);
  st.add({ id: "m1", text: "旧偏好", key: "用户.语言", category: "user", scope: "global", durable: false, importance: 0.5, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  st.add({ id: "m2", text: "新偏好", key: "用户.语言", category: "user", scope: "global", durable: true, importance: 0.5, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  const sup2 = st.supersedeByKey("用户.语言", "m2");
  assert.deepEqual(sup2, ["m1"], "同键旧条目应被取代");
  assert.deepEqual(st.activeMemories().map(m => m.id), ["m2"], "取代后仅新条目活跃");
  await st.save();
  await st.save(); // 第二次覆盖时才会产生 prev 备份
  const st2 = new InkStore(dir);
  assert.equal(st2.find("m1").supersededBy, "m2", "重载后取代关系保留");
  assert.ok(fs.existsSync(path.join(dir, "store.prev.json")), "覆盖前应有 prev 备份");

  // 损坏隔离
  fs.writeFileSync(path.join(dir, "store.json"), "{ not json", "utf8");
  const st3 = new InkStore(dir);
  assert.ok(st3.loadError, "损坏应报告 loadError");
  assert.equal(st3.data.memories.length, 0, "损坏后以空库继续");
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith("store.corrupt-")), "损坏文件被隔离保留");
}

// ---- 会话开关：默认值 + 显式覆盖 ----
{
  const dir = path.join(tmp, "store2");
  const st = new InkStore(dir);
  assert.equal(st.isSessionEnabled("s1", false), false);
  assert.equal(st.isSessionEnabled("s1", true), true);
  st.setSessionEnabled("s1", false);
  assert.equal(st.isSessionEnabled("s1", true), false, "显式关闭应覆盖默认开");
}

// ---- 配额日翻篇 ----
{
  const dir = path.join(tmp, "store3");
  const st = new InkStore(dir);
  st.ensureDay("2026-10-24");
  st.data.counters.autoCaptured = 5;
  st.ensureDay("2026-10-25");
  assert.equal(st.data.counters.autoCaptured, 0, "跨日配额重置");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ink core tests: all passed");
