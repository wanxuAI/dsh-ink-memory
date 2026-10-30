// 墨忆 Ink Memory — 文本检索核心：CJK 友好分词 + BM25 + 半衰期衰减。
// 零依赖。中文按相邻双字 bigram 索引（鱼用的是 jieba 词表，bigram 免词表且不会漏切），
// 英文数字按词。分数语义与 fish 的「证据式召回」对齐：命中词越特别分越高，
// 再乘衰减（鲜活度）、重要度、持久加成。

/** 常见中文虚词，作为 bigram 噪声过滤（小集合即可，BM25 的 idf 会自然压低高频词）。 */
const CJK_STOP = new Set([
  "的", "了", "是", "在", "我", "他", "她", "它", "和", "与", "也", "就", "都",
  "很", "不", "把", "上", "们", "个", "一", "有", "这", "那", "要", "会", "你",
]);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[a-z0-9_]/;

/** 把文本切成检索 token：CJK→bigram(+孤字)，拉丁→≥2 字符的词。 */
export function tokenize(text) {
  const lower = String(text ?? "").toLowerCase();
  const tokens = [];
  let i = 0;
  while (i < lower.length) {
    const ch = lower[i];
    if (CJK.test(ch)) {
      let j = i;
      while (j < lower.length && CJK.test(lower[j])) j += 1;
      const run = lower.slice(i, j);
      if (run.length === 1) {
        if (!CJK_STOP.has(run)) tokens.push(run);
      } else {
        for (let k = 0; k + 1 < run.length; k += 1) {
          const bigram = run.slice(k, k + 2);
          // 过滤两个都是虚词的 bigram（如「的了」）；单边虚词保留，「的车」这类也有信号
          if (CJK_STOP.has(bigram[0]) && CJK_STOP.has(bigram[1])) continue;
          tokens.push(bigram);
        }
      }
      i = j;
    } else if (LATIN.test(ch)) {
      let j = i;
      while (j < lower.length && LATIN.test(lower[j])) j += 1;
      const word = lower.slice(i, j);
      if (word.length >= 2) tokens.push(word);
      i = j;
    } else {
      i += 1;
    }
  }
  return tokens;
}

/** 去重后的 token 集，用于近似重复检测（Jaccard）。 */
export function tokenSet(text) {
  return new Set(tokenize(text));
}

/** Jaccard 相似度，用于「同一条事别记两遍」。 */
export function similarity(aSet, bSet) {
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter += 1;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 微型 BM25 语料库。语料规模小（记忆条目几十~几百），每次 store 版本变化重建，
 * 代价可忽略；如超过几千条再考虑常驻。
 */
export class Bm25 {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docs = []; // {id, tf:Map, len}
    this.df = new Map();
    this.avgLen = 0;
  }

  add(id, tokens) {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.push({ id, tf, len: tokens.length });
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  finish() {
    this.avgLen = this.docs.length
      ? this.docs.reduce((s, d) => s + d.len, 0) / this.docs.length
      : 0;
    return this;
  }

  idf(term) {
    const df = this.df.get(term) ?? 0;
    // Robertson–Spark Jones 平滑，非负
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  /** 返回 Map<id, rawScore>；查询里每个 token 取文档内 tf 贡献之和。 */
  search(queryTokens) {
    const scores = new Map();
    const uniq = new Set(queryTokens);
    for (const term of uniq) {
      const idf = this.idf(term);
      if (idf <= 0) continue;
      for (const d of this.docs) {
        const tf = d.tf.get(term);
        if (!tf) continue;
        const denom = tf + this.k1 * (1 - this.b + (this.b * d.len) / (this.avgLen || 1));
        const add = idf * ((tf * (this.k1 + 1)) / denom);
        scores.set(d.id, (scores.get(d.id) ?? 0) + add);
      }
    }
    return scores;
  }
}

/** 半衰期衰减：ageDays 天后鲜活度 = 0.5^(age/halfLife)。durable 恒为 1。 */
export function freshness(createdAtMs, nowMs, halfLifeDays, durable) {
  if (durable) return 1;
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) return 0; // 脏时间戳：不鲜活但可检索
  const ageDays = Math.max(0, (nowMs - createdAtMs) / 86_400_000);
  return Math.pow(0.5, ageDays / Math.max(0.5, halfLifeDays));
}

/** 人性化日期标签：跨年显示年份。 */
export function dayLabel(iso, nowIso) {
  const d = String(iso ?? "").slice(0, 10);
  const sameYear = d.slice(0, 4) === String(nowIso).slice(0, 4);
  return sameYear ? d.slice(5) : d;
}
