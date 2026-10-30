// 墨忆 Ink Memory — 存储层：单文件 JSON 权威源（唯一权威源判据：store.json）。
// 原子写（tmp→rename），每次覆盖前保留 store.prev.json；损坏时自动隔离损坏文件。
// 不用 SQLite/外部依赖，纯 Node fs，鱼（fish-memory）同款可人肉审阅的思路。

import fs from "node:fs";
import path from "node:path";

const EMPTY = () => ({
  version: 1,
  memories: [],
  sessions: {}, // sessionId -> { enabled: boolean }
  counters: { day: "", autoCaptured: 0, agentCaptured: 0 },
  log: { recalls: [], captures: [], errors: [] },
});

export class InkStore {
  /** @param dir 数据目录（如 ~/.dsh/ink-memory） */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "store.json");
    this.data = EMPTY();
    this.version = 0; // 内存内变更计数（驱动检索索引重建）
    this.loadError = null;
    this._chain = Promise.resolve();
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      this.loadError = `mkdir 失败: ${e?.message ?? e}`;
      return;
    }
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = raw.trim() ? JSON.parse(raw) : EMPTY();
      this.data = this._normalize(parsed);
    } catch (e) {
      // 损坏隔离：保留现场，用空库继续（doctor 会报告）
      try {
        const bad = path.join(this.dir, `store.corrupt-${Date.now()}.json`);
        fs.copyFileSync(this.file, bad);
        this.loadError = `store.json 解析失败，已隔离到 ${bad}: ${e?.message ?? e}`;
      } catch {
        this.loadError = `store.json 解析失败: ${e?.message ?? e}`;
      }
      this.data = EMPTY();
    }
  }

  _normalize(d) {
    const base = EMPTY();
    if (!d || typeof d !== "object") return base;
    return {
      version: 1,
      memories: Array.isArray(d.memories) ? d.memories.filter(m => m && typeof m.text === "string") : [],
      sessions: d.sessions && typeof d.sessions === "object" ? d.sessions : {},
      counters: d.counters && typeof d.counters === "object" ? { ...base.counters, ...d.counters } : base.counters,
      log: {
        recalls: Array.isArray(d.log?.recalls) ? d.log.recalls.slice(0, 20) : [],
        captures: Array.isArray(d.log?.captures) ? d.log.captures.slice(0, 30) : [],
        errors: Array.isArray(d.log?.errors) ? d.log.errors.slice(0, 10) : [],
      },
    };
  }

  /** 立即落盘（写队列串行，tmp→rename 原子替换，旧版留 store.prev.json）。 */
  save() {
    const snapshot = JSON.stringify(this.data, null, 1);
    this._chain = this._chain.then(() => {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, snapshot, "utf8");
      if (fs.existsSync(this.file)) {
        try {
          fs.copyFileSync(this.file, path.join(this.dir, "store.prev.json"));
        } catch { /* 备份失败不阻塞写入 */ }
      }
      fs.renameSync(tmp, this.file);
    }).catch((e) => {
      this.logError(`落盘失败: ${e?.message ?? e}`);
    });
    return this._chain;
  }

  bump() {
    this.version += 1;
  }

  // ---------- 记忆 CRUD ----------

  activeMemories() {
    return this.data.memories.filter(m => !m.deletedAt && !m.supersededBy);
  }

  find(id) {
    return this.data.memories.find(m => m.id === id);
  }

  /** 同 key（对象.方面）的现行记忆。 */
  findByKey(key) {
    if (!key) return [];
    return this.data.memories.filter(m => m.key === key && !m.deletedAt && !m.supersededBy);
  }

  add(mem) {
    this.data.memories.push(mem);
    this.bump();
  }

  /** 把旧的现行同键记忆标记为被取代（内容保留、可复原——fish 的不删只淡出原则）。 */
  supersedeByKey(newKey, newId) {
    if (!newKey) return [];
    const old = this.findByKey(newKey).filter(m => m.id !== newId);
    for (const m of old) m.supersededBy = newId;
    if (old.length) this.bump();
    return old.map(m => m.id);
  }

  touchHit(mem) {
    mem.hits = (mem.hits ?? 0) + 1;
    mem.lastHitAt = new Date().toISOString();
  }

  // ---------- 会话开关（默认全关，鱼原则） ----------

  isSessionEnabled(sessionId, fallback) {
    const s = this.data.sessions[String(sessionId)];
    return s && typeof s.enabled === "boolean" ? s.enabled : Boolean(fallback);
  }

  setSessionEnabled(sessionId, enabled) {
    this.data.sessions[String(sessionId)] = { enabled: Boolean(enabled) };
    this.save();
  }

  // ---------- 配额与日志 ----------

  ensureDay(dayKey) {
    if (this.data.counters.day !== dayKey) {
      this.data.counters.day = dayKey;
      this.data.counters.autoCaptured = 0;
      this.data.counters.agentCaptured = 0;
    }
  }

  logRecall(entry) {
    this.data.log.recalls = [entry, ...this.data.log.recalls].slice(0, 20);
  }

  logCapture(entry) {
    this.data.log.captures = [entry, ...this.data.log.captures].slice(0, 30);
  }

  logError(entry) {
    const e = typeof entry === "string" ? { at: new Date().toISOString(), error: entry } : entry;
    this.data.log.errors = [e, ...this.data.log.errors].slice(0, 10);
  }
}
