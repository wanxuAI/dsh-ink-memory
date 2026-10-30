# 墨忆 Ink Memory（dsh-ink-memory）

DSH（DeepSeek Harness）跨会话长期记忆插件。零依赖、单文件存储、全可观测。
综合了社区各记忆插件的优点并避开其坑：

| 特性 | 来源 | 在本插件中的实现 |
|---|---|---|
| 半衰期淡忘（默认 30 天）| dsh-fish-memory | `freshness = 0.5^(age/halfLife)`，`durable` 条目永不淡忘 |
| 每日捕获配额 + 注入预算 | fish | 自动蒸馏 8 条/日；注入最多 6 条 / 800 字符 |
| 事实键「对象.方面」新旧取代 | fish | 同 `key` 再记录 → 旧条目 `supersededBy` 淡出（不删除、可复原）|
| 可观测的召回理由 | fish | 每次注入留痕：带入哪些、其余为何被 limit/budget/score 排除 |
| 分类存储 | dsh-meow-memory | `user / project / fact / lesson / note` 五类（简化其七层）|
| BM25 检索 | meow | 小语料 BM25 + 证据词计数兜底（小语料 idf 塌缩修正）|
| 中文分词 | fish(jieba) | 免依赖 CJK bigram + 虚词过滤 + ASCII 词 |
| 每轮自动召回注入 | dsh-auto-memory | `systemPrompt.section`（仅按当前话题命中时注入）|
| 轮末 LLM 自动蒸馏 | auto-memory / fish | 默认每 2 轮一次，配额受控，可整体关闭 |
| agent 显式记录 | justhalfbit/dsh-plugin-memory | `ink_remember` 工具（主通道，零额外成本）|
| 近似重复自动合并 | 自研 | token 集 Jaccard ≥0.6 → 更新旧条目而非新增 |
| 唯一权威源、不污染会话 | dsh-agent-soul 判据 | 只写 `store.json`；不向会话日志追加事件、不注册 guard/hook |

## 安装

DSH（≥含插件系统的版本）里两种方式：

1. 本仓库 git clone 到本地任意目录，然后 `plugin_manager → install_bundle → target: 该目录绝对路径`；
2. 已把源码放好的本机用户：直接对源码目录 install_bundle。

（安装会在 profile 的 `cordis.patch.yml` 写入一行；不要手编。当前版本见 `package.json`，v1.1.1。）

## 仓库结构

```
index.js          宿主插件：工具注册、注入、自动蒸馏、/api/ink-memory/* 路由、管理面板后端
lib/store.js      单文件存储 store.json（原子写 + prev 备份 + 损坏隔离）
lib/text.js       免依赖中文检索：CJK bigram 分词、BM25、小语料 idf 修正
lib/client.js     设置页「墨忆记忆」管理面板（client bundle，DSH 启动时快照加载）
test/             单测与 mock-ctx 冒烟测试（node --test，不依赖 DSH 运行时）
locale/           文案资源
icon.svg          插件图标
```

## 数据

- 位置：`~/.dsh/ink-memory/store.json`（可人肉审阅；覆盖前自动留 `store.prev.json`）
- 损坏自动隔离为 `store.corrupt-*.json` 并以空库继续，`ink_manage status` 会报告
- 会话日志永远是原始真相；本库是派生缓存，删掉即可重建

## 三个工具

- `ink_remember` — 记录（category/key/durable/scope 可选；同 key 自动取代旧条目）
- `ink_search` — 主动检索历史记忆（带新鲜度、来源、年龄）
- `ink_manage` — 管理与观测：`status`（健康+最近注入/捕获日志）、`list`、
  `enable` / `disable`（按会话开关注入）、`forget`（软删）、`delete`、`reinstate`、`update`、`pin`

## 管理面板（设置页）

设置 → **墨忆记忆**（位于「Agent 预设」之下）：状态条（现行/已钉/被取代/今日配额）、
快速记录、列表/语义检索、编辑/钉住/淡出/恢复/彻底删除、按会话注入开关、最近注入留痕。
面板走宿主 `/api/ink-memory/*` 路由，与三个工具共用同一操作层（一个操作，两个调用方）。

## 注入行为

每轮按用户最新输入检索，命中才注入（默认 ≤6 条、800 字符、证据分 ≥1.0）。
注入段位于系统提示尾部 `<ink_memory>` 块内，标注类别/日期/鲜活度/事实键。

## 配置（写入 patch 行的 `config`，升级后存活）

```yaml
config:
  halfLifeDays: 30        # 半衰期
  recallLimit: 6          # 注入条数上限
  charBudget: 800         # 注入字符预算
  minScore: 1.0           # 证据分下限（调高=更克制的注入）
  enabledByDefault: true  # 新会话默认参与（false=fish 式逐会话手动开）
  autoExtract: true       # 轮末自动蒸馏
  extractEveryTurns: 2    # 蒸馏频率
  dailyQuota: 8           # 自动蒸馏每日条数上限
  dedupThreshold: 0.6     # 近似重复合并阈值
  homeDir: null           # 数据目录覆盖
  extractProvider: null   # 蒸馏模型覆盖（默认跟随当前默认模型）
  extractModel: null
```

## 只装一个记忆插件

多记忆插件 = 多份真相。安装本插件时请确保没有别的记忆插件同时在注入。

## 开发与测试

```
npm test   # node --check + 核心单测 + mock-ctx 冒烟测试（不依赖 DSH 运行时）
```

## Roadmap（v1.2+）

- `ink_import`：从归档 md/txt 批量导入候选记忆
- 记忆时间线/合并链可视化（取代链目前以徽标+列表呈现）

## v1.1 新增

- 设置页「墨忆记忆」管理面板（设置 → Agent 预设之下）+ `/api/ink-memory/*` 宿主路由
- `pin` 支持取消钉；`session enabled:null` 重置回默认（工具与面板同实现）
- 1.1.1 修复：client 侧 `ctx.slots.register` 必须携带 `name`（slot 绑定），否则设置区不出现

## License

MIT © 2026 wanxuAI
