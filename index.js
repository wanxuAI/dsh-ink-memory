// 墨忆 Ink Memory — DSH 跨会话长期记忆插件（host, 零依赖）
//
// 设计判据（来自 agent-soul 的「每份记忆都要回答四问」与各家实践融合）：
//   1. 唯一权威源：store.json（~/.dsh/ink-memory），无第二份账本；会话日志仍是原始真相，
//      本库只是从对话中「蒸馏」出的派生缓存，删掉即可重建，不反向污染会话。
//   2. 触发方式：agent 显式 ink_remember（主通道）+ 轮末自动蒸馏（配额受控，可关）。
//   3. 失败模式：store 损坏自动隔离并在 status 中报告；LLM 蒸馏失败只记 error 不影响对话。
//   4. 观测面：每次注入都记录「带入了什么、为什么没带别的」（ink_manage status 可见）。
//
// 机制选择（最弱充分机制）：不注册 tools.guard、不写会话事件、不 hook 中间件——
// 只用 systemPrompt.section（注入）+ tools.register（读写）+ 事件监听（蒸馏时机）。

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { InkStore } from "./lib/store.js";
import { tokenize, tokenSet, similarity, Bm25, freshness, dayLabel } from "./lib/text.js";

export const inject = ["tools", "systemPrompt", "agents", "sessions", "webServer"];

const API_PREFIX = "/api/ink-memory";

// webServer 路由的 JSON 辅助（与 skillhub 同款约定：res.writeHead/end）
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 200_000) { req.destroy(); reject(new Error("body 过大")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new Error("JSON 解析失败: " + (e?.message ?? e))); }
    });
    req.on("error", reject);
  });
}

const DEFAULTS = {
  homeDir: null,          // 默认 ~/.dsh/ink-memory
  halfLifeDays: 30,       // 半衰期（fish：30 天记忆淡忘一半鲜活度）
  recallLimit: 6,         // 每次注入最多条数（fish 的注入预算）
  charBudget: 800,        // 注入记忆文本的字符预算
  minScore: 1.0,          // 证据分下限（BM25 + 每个命中证据词 +1.15）
  enabledByDefault: true, // 新会话默认参与注入（可 per-session 关闭）
  autoExtract: true,      // 轮末自动蒸馏（有每日配额）
  extractEveryTurns: 2,   // 每 N 个轮次蒸馏一次
  dailyQuota: 8,          // 自动蒸馏每日上限（fish 的每日捕获配额）
  agentDailyCap: 50,      // 显式记录每日硬上限（防刷屏）
  dedupThreshold: 0.6,    // 近似重复合并阈值（token 集 Jaccard）
  extractProvider: null,  // 蒸馏模型覆盖；默认跟随当前默认模型
  extractModel: null,
};

const CATEGORIES = ["user", "project", "fact", "lesson", "note"];

const EXTRACT_SYSTEM = [
  "你在为对话代理做记忆蒸馏。从给定对话片段里提取最多 2 条「值得跨会话记住」的信息。",
  "规则：只记稳定事实（用户偏好/身份/项目决定/纠错教训），不记闲聊、不记一次性任务状态、不记可从文件查到的内容。",
  "每条 8~120 字，自包含（不用「他/这个」等指代）。key 用「对象.方面」格式（可选）。",
  "durable=true 表示多年有效（身份/长期偏好），否则随时间淡忘。",
  '只输出 JSON 数组，例如 [{"text":"...","category":"user","key":"用户.语言偏好","durable":true}]；没有值得记的就输出 []。',
].join("\n");

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const dir = cfg.homeDir
    ? path.resolve(String(cfg.homeDir))
    : path.join(os.homedir(), ".dsh", "ink-memory");
  const store = new InkStore(dir);
  if (store.loadError) store.logError({ at: new Date().toISOString(), error: store.loadError });

  // ---- 派生检索索引（store.version 变化时重建；语料小，重建便宜） ----
  let indexCache = { version: -1, bm25: null, byId: new Map() };
  function getIndex() {
    if (indexCache.version !== store.version) {
      const bm25 = new Bm25();
      const byId = new Map();
      for (const m of store.activeMemories()) {
        const toks = tokenize(m.text);
        bm25.add(m.id, toks);
        byId.set(m.id, { mem: m, set: new Set(toks) });
      }
      indexCache = { version: store.version, bm25: bm25.finish(), byId };
    }
    return indexCache;
  }

  const dayKey = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  // ---- 捕获（去重 / 同键取代 / 配额） ----
  function remember({ text, category, key, durable, importance, scope, session, source }) {
    const clean = String(text ?? "").trim().replace(/\s+/g, " ");
    if (clean.length < 2) return { error: "text 太短（至少 2 个字符）" };
    if (clean.length > 500) return { error: "text 超过 500 字符，请拆细或精简" };

    store.ensureDay(dayKey());
    if (source === "auto") {
      if (store.data.counters.autoCaptured >= Math.max(0, cfg.dailyQuota))
        return { error: `今日自动蒸馏配额已用完（${cfg.dailyQuota} 条/日）` };
    } else {
      if (store.data.counters.agentCaptured >= Math.max(0, cfg.agentDailyCap))
        return { error: `今日显式记录已达上限（${cfg.agentDailyCap} 条/日）` };
    }

    // 近似重复：更新旧条目而不是加新条目（fish 的「同一件事别记两遍」）
    const newSet = tokenSet(clean);
    let dup = null;
    let bestSim = 0;
    for (const m of store.activeMemories()) {
      const s = similarity(newSet, tokenSet(m.text));
      if (s > bestSim) { bestSim = s; dup = m; }
    }
    if (dup && bestSim >= Math.min(0.95, Math.max(0.3, cfg.dedupThreshold))) {
      dup.text = clean;
      dup.updatedAt = new Date().toISOString();
      if (category && CATEGORIES.includes(category)) dup.category = category;
      if (durable === true) dup.durable = true;
      store.bump();
      void store.save();
      store.logCapture({ at: dup.updatedAt, id: dup.id, via: source, deduped: true });
      return { id: dup.id, deduped: true, similarity: Number(bestSim.toFixed(2)) };
    }

    const now = new Date().toISOString();
    const mem = {
      id: `ink-${randomUUID().slice(0, 8)}`,
      text: clean,
      category: CATEGORIES.includes(category) ? category : "note",
      scope: scope === "session" ? "session" : "global",
      session: session ? String(session) : null,
      key: key ? String(key).trim().toLowerCase().slice(0, 60) : null,
      durable: durable === true,
      importance: clamp01(importance ?? 0.5),
      createdAt: now,
      updatedAt: now,
      hits: 0,
    };
    store.add(mem);
    const superseded = store.supersedeByKey(mem.key, mem.id);
    store.data.counters[source === "auto" ? "autoCaptured" : "agentCaptured"] += 1;
    void store.save();
    store.logCapture({ at: now, id: mem.id, via: source, superseded });
    return { id: mem.id, superseded };
  }

  // ---- 证据式召回：BM25 × 衰减 × 加成，带「为什么没带入」的理由 ----
  function recall(query, sessionId, limit, budget, opts = {}) {
    const now = Date.now();
    const nowIso = new Date().toISOString();
    const pool = store.activeMemories().filter((m) => {
      if (m.scope === "session") return m.session === String(sessionId);
      return true; // global：跨会话可见
    });
    const { bm25, byId } = getIndex();
    const qTokens = tokenize(query);
    const qUniq = new Set(qTokens);
    const raw = bm25.search(qTokens);
    const ranked = [];
    for (const [id, score0] of raw) {
      const entry = byId.get(id);
      const m = entry?.mem;
      if (!m) continue;
      // 小语料下 BM25 的 idf 塌缩，证据词计数兜底：每个命中的不同查询词 +1.15
      let matched = 0;
      for (const t of qUniq) if (entry.set.has(t)) matched += 1;
      const score = score0 + 1.15 * matched;
      const fresh = freshness(Date.parse(m.updatedAt ?? m.createdAt), now, cfg.halfLifeDays, m.durable);
      let final = score * (0.3 + 0.7 * fresh) * (1 + 0.5 * (m.importance ?? 0.5));
      if (m.durable) final *= 1.4;
      if (m.session === String(sessionId)) final *= 1.15; // 本会话来源轻微加成
      ranked.push({ m, score, fresh, final });
    }
    ranked.sort((a, b) => b.final - a.final);

    const max = opts.forSearch ? (limit ?? 20) : cfg.recallLimit;
    const charBudget = opts.forSearch ? Infinity : cfg.charBudget;
    const included = [];
    const excluded = [];
    let chars = 0;
    for (const r of ranked) {
      if (included.length >= max) { excluded.push({ id: r.m.id, reason: "limit" }); continue; }
      if (!opts.forSearch && r.score < cfg.minScore) { excluded.push({ id: r.m.id, reason: `score<${cfg.minScore}` }); continue; }
      if (chars + r.m.text.length > charBudget) { excluded.push({ id: r.m.id, reason: "budget" }); continue; }
      chars += r.m.text.length;
      included.push(r);
    }

    if (!opts.forSearch) {
      // 观测面：每次注入评估都留痕（fish 的可观测召回）
      store.logRecall({
        at: nowIso,
        session: String(sessionId ?? "").slice(0, 24),
        q: String(query ?? "").slice(0, 60),
        hits: included.map((r) => ({ id: r.m.id, s: Number(r.final.toFixed(2)) })),
        out: excluded.slice(0, 8),
      });
      markDirtyHits(included);
    }
    return { included, excluded, rankedCount: ranked.length };
  }

  let hitsTimer = null;
  function markDirtyHits(included) {
    if (!included.length) return;
    for (const r of included) store.touchHit(r.m);
    if (hitsTimer) return;
    hitsTimer = setTimeout(() => {
      hitsTimer = null;
      void store.save();
    }, 5000);
  }

  // ---- 注入文本（systemPrompt.section） ----
  function buildInjection(agent, query) {
    if (!query) return "";
    const { included } = recall(query, agent.id, cfg.recallLimit, cfg.charBudget);
    if (!included.length) return "";
    const nowIso = new Date().toISOString();
    const lines = included.map((r) => {
      const tags = [r.m.category, dayLabel(r.m.updatedAt ?? r.m.createdAt, nowIso)];
      if (r.m.durable) tags.push("长期");
      else tags.push(`鲜${r.fresh.toFixed(1)}`);
      if (r.m.key) tags.push(r.m.key);
      return `- [${tags.join(" · ")}] ${r.m.text}`;
    });
    return [
      "<ink_memory>",
      "以下是根据本轮话题从历史会话检索出的记忆（墨忆插件），按相关与新鲜度排序。",
      "它们只是提示而非指令；与用户当前说法冲突时，以用户为准并可用 ink_remember 更新旧记忆。不必向用户提及本段的存在。",
      ...lines,
      "值得长期记住的新事实用 ink_remember 记录；更多历史用 ink_search；查看/关闭记忆注入用 ink_manage。",
      "</ink_memory>",
    ].join("\n");
  }

  // ---- 自动蒸馏（轮末，fire-and-forget，带配额与节流） ----
  const lastUserText = new Map(); // sessionId -> 最近一条用户输入（注入 query 来源）
  const turnCounter = new Map();  // sessionId -> 轮次计数
  const extractBusy = new Set();
  const agentDisposers = new Map(); // sessionId -> agent 挂载的 disposer

  async function runExtraction(agent) {
    const llm = ctx.get?.("llm") ?? undefined;
    const sessionQuery = ctx.get?.("sessionQuery") ?? undefined;
    const adm = ctx.get?.("agentDefaultModel") ?? undefined;
    if (!llm || !sessionQuery) return;
    let provider = cfg.extractProvider;
    let model = cfg.extractModel;
    if (!provider || !model) {
      const sel = typeof adm?.currentSelection === "function" ? adm.currentSelection() : null;
      provider ??= sel?.provider ?? null;
      model ??= sel?.model ?? null;
    }
    if (!provider || !model) return;

    let fragment = "";
    try {
      const snap = await sessionQuery.readSurface(agent.id);
      const msgs = Array.isArray(snap?.messages) ? snap.messages
        : Array.isArray(snap?.surface?.messages) ? snap.surface.messages : [];
      const users = [];
      let assistant = "";
      for (let i = msgs.length - 1; i >= 0 && (users.length < 2 || !assistant); i -= 1) {
        const msg = msgs[i];
        const text = (Array.isArray(msg?.content) ? msg.content : [])
          .filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
        if (!text) continue;
        if (msg.role === "user" && users.length < 2) users.push(`用户：${text.slice(0, 600)}`);
        else if (msg.role === "assistant" && !assistant) assistant = `助手：${text.slice(0, 600)}`;
      }
      fragment = [...users.reverse(), assistant].filter(Boolean).join("\n");
    } catch (e) {
      store.logError({ at: new Date().toISOString(), error: `读取会话表面失败: ${e?.message ?? e}` });
      return;
    }
    if (fragment.length < 24) return;

    try {
      let out = "";
      for await (const ch of llm.stream({
        provider, model,
        system: EXTRACT_SYSTEM,
        messages: [{ role: "user", content: [{ type: "text", text: fragment }] }],
        maxTokens: 600, temperature: 0.2,
      })) {
        if (ch.type === "text-delta") out += ch.text;
        else if (ch.type === "finish" && ch.reason?.kind === "error")
          throw new Error(`llm 蒸馏失败: ${ch.reason?.failure?.message ?? "unknown"}`);
      }
      const m = /\[[\s\S]*\]/.exec(out);
      if (!m) return;
      const items = JSON.parse(m[0]);
      if (!Array.isArray(items)) return;
      for (const it of items.slice(0, 2)) {
        if (!it || typeof it.text !== "string") continue;
        const r = remember({
          text: it.text, category: it.category, key: it.key,
          durable: it.durable === true, importance: 0.5,
          scope: "global", session: agent.id, source: "auto",
        });
        if (r.error) store.logError({ at: new Date().toISOString(), error: `自动蒸馏被拒: ${r.error}` });
      }
    } catch (e) {
      store.logError({ at: new Date().toISOString(), error: `自动蒸馏异常: ${e?.message ?? e}` });
    }
  }

  // ---- 每个 Agent 的挂载：注入段 + 用户输入跟踪 + 轮末蒸馏 ----
  // HMR/热安装时已存活的 Agent 不会再现 agent/created，启动时先补挂一遍。
  function mountAgent(agent) {
    if (!agent?.id || agentDisposers.has(String(agent.id))) return;
    const key = String(agent.id);
    const scoped = agent.ctx ?? ctx; // scoped 注册走 agent 子上下文（systemPrompt/tools 同源服务）
    const dispose = agent.ctx.effect(() => {
      const offSection = (scoped.systemPrompt ?? ctx.systemPrompt).section({
        name: "ink-memory",
        order: 900,
        text: () => {
          if (!store.isSessionEnabled(agent.id, cfg.enabledByDefault)) return "";
          return buildInjection(agent, lastUserText.get(key) ?? "");
        },
      });
      const offInbox = scoped.on("agent/inbox/inserted", (payload) => {
        const msg = payload?.message ?? payload;
        const text = (Array.isArray(msg?.content) ? msg.content : [])
          .filter((b) => b?.type === "text").map((b) => b.text).join(" ").trim();
        if (text) lastUserText.set(key, text.slice(0, 500));
      });
      const offTurn = scoped.on("agent/turn-stopping", () => {
        if (!cfg.autoExtract) return;
        if (!store.isSessionEnabled(agent.id, cfg.enabledByDefault)) return;
        store.ensureDay(dayKey());
        if (store.data.counters.autoCaptured >= Math.max(0, cfg.dailyQuota)) return;
        const n = (turnCounter.get(key) ?? 0) + 1;
        turnCounter.set(key, n);
        if (n % Math.max(1, cfg.extractEveryTurns) !== 0) return;
        if (extractBusy.has(key)) return;
        extractBusy.add(key);
        void runExtraction(agent).finally(() => extractBusy.delete(key));
      });
      return () => { offSection?.(); offInbox?.(); offTurn?.(); };
    });
    agentDisposers.set(key, dispose);
  }

  ctx.on("agent/created", ({ agent }) => mountAgent(agent));

  // 热安装时已存活的 Agent（含当前会话）：启动时补挂，注入从下一个模型步开始生效
  try {
    const live = typeof ctx.agents?.list === "function" ? ctx.agents.list() : [];
    for (const agent of live) mountAgent(agent);
  } catch { /* 无存活 agent */ }

  ctx.on("agent/disposed", ({ agent }) => {
    if (!agent?.id) return;
    const key = String(agent.id);
    agentDisposers.get(key)?.();
    agentDisposers.delete(key);
    lastUserText.delete(key);
    turnCounter.delete(key);
  });

  // ---- 共享操作层：agent 工具与设置面板 UI 走同一实现（一操作两调用方） ----
  const manageOps = {
    status() {
      return {
        store: {
          dir, loadError: store.loadError ?? null,
          total: store.data.memories.length,
          active: store.activeMemories().length,
          softDeleted: store.data.memories.filter((m) => m.deletedAt && !m.supersededBy).length,
          superseded: store.data.memories.filter((m) => m.supersededBy).length,
          durable: store.activeMemories().filter((m) => m.durable).length,
          byCategory: CATEGORIES.map((c) => [c, store.activeMemories().filter((m) => m.category === c).length]).filter(([, n]) => n),
        },
        config: { halfLifeDays: cfg.halfLifeDays, recallLimit: cfg.recallLimit, charBudget: cfg.charBudget, minScore: cfg.minScore, enabledByDefault: cfg.enabledByDefault, autoExtract: cfg.autoExtract, extractEveryTurns: cfg.extractEveryTurns, dailyQuota: cfg.dailyQuota },
        today: { ...store.data.counters },
        sessionFlags: Object.fromEntries(Object.entries(store.data.sessions).slice(-12)),
        lastRecalls: store.data.log.recalls.slice(0, 8),
        lastCaptures: store.data.log.captures.slice(0, 8),
        recentErrors: store.data.log.errors.slice(0, 5),
      };
    },
    list({ q, all } = {}) {
      const needle = String(q ?? "").trim().toLowerCase();
      let pool = store.data.memories;
      if (!all) pool = pool.filter((m) => !m.deletedAt);
      if (needle) pool = pool.filter((m) => m.text.toLowerCase().includes(needle) || String(m.key ?? "").toLowerCase().includes(needle));
      const nowIso = new Date().toISOString();
      const items = pool.slice(0, 200).map((m) => ({
        id: m.id, text: m.text, category: m.category, key: m.key ?? null,
        durable: m.durable, scope: m.scope ?? "global", session: m.session ?? null,
        state: m.deletedAt ? "forgotten" : m.supersededBy ? `superseded-by:${m.supersededBy}` : "active",
        created: dayLabel(m.createdAt, nowIso), updated: dayLabel(m.updatedAt ?? m.createdAt, nowIso),
        ageDays: Math.round((Date.now() - Date.parse(m.updatedAt ?? m.createdAt)) / 86_400_000),
        hits: m.hits ?? 0,
      }));
      return { count: items.length, items };
    },
    search(query, sessionId, limit) {
      const { included, rankedCount } = recall(String(query ?? ""), sessionId ?? "panel", clampInt(limit ?? 8, 1, 20), 0, { forSearch: true });
      const nowIso = new Date().toISOString();
      return {
        total: rankedCount,
        results: included.map((r) => ({
          id: r.m.id, text: r.m.text, category: r.m.category,
          key: r.m.key ?? null, durable: r.m.durable,
          ageDays: Math.round((Date.now() - Date.parse(r.m.updatedAt ?? r.m.createdAt)) / 86_400_000),
          freshness: Number(r.fresh.toFixed(2)),
          origin: r.m.scope === "global" ? "global" : `session:${String(r.m.session ?? "").slice(0, 12)}`,
          updated: dayLabel(r.m.updatedAt ?? r.m.createdAt, nowIso),
        })),
      };
    },
    remember(args) {
      return remember({ ...args, session: args?.session ?? null, source: "user" });
    },
    setSession(sessionId, enabled) {
      const sid = String(sessionId ?? "");
      if (!sid) return { error: "缺少 session" };
      if (enabled === null) {
        delete store.data.sessions[sid];
        store.bump(); void store.save();
        return { [sid]: "reset" };
      }
      store.setSessionEnabled(sid, Boolean(enabled));
      return { [sid]: Boolean(enabled) };
    },
    mutate(action, id, extra) {
      const mem = store.find(String(id ?? ""));
      if (!mem) return { error: `找不到记忆 id：${id ?? "(空)"}` };
      if (action === "forget") { mem.deletedAt = new Date().toISOString(); store.bump(); void store.save(); return { id: mem.id, forgotten: true }; }
      if (action === "delete") { store.data.memories = store.data.memories.filter((m) => m.id !== mem.id); store.bump(); void store.save(); return { id: mem.id, deleted: true }; }
      if (action === "reinstate") { mem.deletedAt = null; mem.supersededBy = null; store.bump(); void store.save(); return { id: mem.id, active: true }; }
      if (action === "update") {
        const t = String(extra?.text ?? "").trim();
        if (t.length < 2) return { error: "text 太短" };
        mem.text = t.slice(0, 500);
        mem.updatedAt = new Date().toISOString();
        store.bump(); void store.save();
        return { id: mem.id, updated: true };
      }
      if (action === "pin") { mem.durable = extra?.durable !== false; store.bump(); void store.save(); return { id: mem.id, durable: mem.durable }; }
      return { error: `未知 action：${action}` };
    },
  };

  // ---- 工具：3 个（记录 / 检索 / 管理+观测），全局注册，按 exec.agent 定位会话 ----
  const agentOf = (exec) => exec?.agent ?? null;

  ctx.tools.register({
    name: "ink_remember",
    description:
      "把值得跨会话长期记住的信息写入长期记忆（墨忆）。适合：用户稳定偏好/身份背景、项目层面的决定与约束、被用户纠正过的做法教训。不适合：一次性任务状态、能从文件/历史直接查到的内容、闲聊。同一主题用同一个 key（对象.方面）再记一次，旧条目会自动淡出、新条目取代。用户明确说「记住…」时必用。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要记住的内容，8~120 字最佳，自包含、不依赖当前上下文。" },
        category: { type: "string", enum: CATEGORIES, description: "user=关于用户本人；project=项目/工程事实；fact=一般事实；lesson=纠错教训；note=其他。默认 note。" },
        key: { type: "string", description: "可选。事实键「对象.方面」，如「用户.语言偏好」。同键新记录会取代旧记录。" },
        durable: { type: "boolean", description: "true=多年有效的长期记忆（身份、长期偏好），不会随时间淡忘。" },
        importance: { type: "number", description: "0~1 权重，默认 0.5，影响检索排序。" },
        scope: { type: "string", enum: ["global", "session"], description: "global=所有会话可见（默认）；session=仅本会话可见。" },
      },
      required: ["text"],
    },
    output: {
      schema: { type: "object" },
      render: (args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const a = agentOf(exec);
      const r = remember({ ...args, session: a?.id, source: "agent" });
      return r;
    },
  });

  ctx.tools.register({
    name: "ink_search",
    description:
      "检索长期记忆（墨忆）：按关键词/自然语言查询历史记住的事实，返回带新鲜度与来源的命中列表。注入段只按当前话题自动带入最相关的几条；要主动翻旧账、确认「以前记过什么」时用本工具。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "查询词或一句话。中英文皆可。" },
        limit: { type: "integer", description: "最多返回条数（1~20，默认 8）。" },
      },
      required: ["query"],
    },
    output: {
      schema: { type: "object" },
      render: (args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    async execute(args, exec) {
      const a = agentOf(exec);
      return manageOps.search(args?.query, a?.id ?? null, args?.limit);
    },
  });

  ctx.tools.register({
    name: "ink_manage",
    description:
      "记忆库管理与观测（墨忆）。status=健康检查与最近注入/捕获日志（看某条记忆为什么没被带入）；list=列出当前记忆；enable/disable=对本会话开关记忆注入（可用 session_id 改别的会话）；forget=让某条淡出（软删）；delete=彻底删除；reinstate=恢复被淡出/取代的条目；update=改写某条内容；pin=标记为长期不淡忘（durable）。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "list", "enable", "disable", "forget", "delete", "reinstate", "update", "pin"], description: "操作类型。" },
        id: { type: "string", description: "记忆条目 id（forget/delete/reinstate/update/pin 必需）。" },
        text: { type: "string", description: "update 时的新内容。" },
        session_id: { type: "string", description: "enable/disable 可选目标会话；缺省=当前会话。" },
      },
      required: ["action"],
    },
    output: {
      schema: { type: "object" },
      render: (args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    async execute(args, exec) {
      const a = agentOf(exec);
      const act = args?.action;
      const sid = args?.session_id ? String(args.session_id) : (a?.id ? String(a.id) : null);

      if (act === "enable" || act === "disable") {
        if (!sid) return { error: "无法确定会话" };
        return manageOps.setSession(sid, act === "enable");
      }
      if (act === "status") return manageOps.status();
      if (act === "list") return manageOps.list({});
      return manageOps.mutate(act, args?.id, { text: args?.text });
    },
  });

  // ---- 设置面板 API：与工具同一实现（设置里「墨忆记忆」区的 client UI 用） ----
  if (ctx.webServer) {
    ctx.effect(() => {
      const offs = [];
      const guard = (h) => async (req, res) => {
        try { await h(req, res); }
        catch (e) { json(res, 500, { error: String(e?.message ?? e) }); }
      };
      const getRoute = (p, h) => offs.push(ctx.webServer.register({
        kind: "exact", path: API_PREFIX + p,
        handler: guard(async (req, res) => {
          if (req.method !== "GET") return json(res, 405, { error: "仅支持 GET" });
          const u = new URL(req.url ?? API_PREFIX + p, "http://localhost");
          json(res, 200, h(u.searchParams));
        }),
      }));
      const postRoute = (p, h) => offs.push(ctx.webServer.register({
        kind: "exact", path: API_PREFIX + p,
        handler: guard(async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "仅支持 POST" });
          const body = await readBody(req);
          const r = h(body ?? {});
          json(res, r && r.error ? 400 : 200, r);
        }),
      }));

      getRoute("/health", () => ({ ok: true, plugin: "dsh-ink-memory" }));
      getRoute("/status", () => manageOps.status());
      getRoute("/list", (sp) => manageOps.list({ q: sp.get("q") ?? "", all: sp.get("all") === "1" }));
      getRoute("/search", (sp) => manageOps.search(sp.get("q") ?? "", sp.get("session") || null, Number(sp.get("limit") ?? 8)));
      postRoute("/remember", (b) => manageOps.remember(b));
      postRoute("/update", (b) => manageOps.mutate("update", b?.id, { text: b?.text }));
      postRoute("/forget", (b) => manageOps.mutate("forget", b?.id));
      postRoute("/reinstate", (b) => manageOps.mutate("reinstate", b?.id));
      postRoute("/delete", (b) => manageOps.mutate("delete", b?.id));
      postRoute("/pin", (b) => manageOps.mutate("pin", b?.id, { durable: b?.durable }));
      postRoute("/session", (b) => manageOps.setSession(
        b?.session,
        b && "enabled" in b ? (b.enabled === null ? null : Boolean(b.enabled)) : true,
      ));

      return () => { for (const off of offs) { try { off?.(); } catch { /* 忽略 */ } } };
    }, "dsh-ink-memory: api routes");
  }

  // ---- 卸载清理：清 agent 挂载 + 落盘 + 清计时器 ----
  ctx.effect(() => () => {
    for (const d of agentDisposers.values()) { try { d?.(); } catch { /* 忽略 */ } }
    agentDisposers.clear();
    if (hitsTimer) clearTimeout(hitsTimer);
    void store.save();
  });
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
function clampInt(x, lo, hi) {
  const n = Math.trunc(Number(x));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
