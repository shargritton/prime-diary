# dsh-prime-diary

为 [DSH](https://github.com/deepseek-ai) 的 `dsh-prime-memory` 增加「每日日记 + 重要记忆筛选 + 草稿审阅」的伴生插件。

- 不改动 `dsh-prime-memory` 源码，通过其数据/导入通道写入
- 先出草稿、人工采纳；稳定后再开全自动
- 日记按 `[上次生成, 现在)` 区间取材，文件按结束日期命名

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | 桌面端 / Web 端，宿主版本需支持 `dsh.bundle` 插件格式 |
| Node | ≥ 22.19（用到 `zlib.zstdDecompressSync`） |
| **dsh-prime-memory** | **必装**。本插件是它的伴生插件，直接读写它的记忆库 |
| `sqlite3` 命令 | 系统 PATH 里要能执行 `sqlite3`（macOS 自带；Debian/Ubuntu 需 `apt install sqlite3`） |
| 宿主依赖 | `@deepseek-ai/cordis` ^4、`@deepseek-ai/schemastery` ^3（由宿主提供） |
| 可选 | `@node-rs/jieba`（装了就按词切分，没装则退化为逐字切分） |

## 前置依赖：dsh-prime-memory

这个插件不自己存记忆，日记和提炼出的条目最终都写进 **`dsh-prime-memory` 的记忆库**：

```
$DSH_HOME/memory/memory.db
```

所以请先装好 `dsh-prime-memory` 并让它正常跑起来（至少要有一份能打开的 `memory.db`）。

- 写入方式是直接对库做 SQLite 事务：`l1_records` + `l1_fts` 两张表，列结构对应 prime 0.26.x
- 每次写入前会自动 `VACUUM INTO` 备份到 `$DSH_HOME/prime-diary/backups/`
- 按 `ext_key` 幂等：同一篇日记重复采纳不会重复入库
- 设置页提供「写入通道自检」：复制一份库去试写并校验 FTS，不动正式数据
- 如果没装 prime / 库不存在，采纳时会失败并提示 `prime memory.db 不存在: <路径>`；草稿不会丢，`pending-write` 载荷留在 `prime-diary/outbox/` 里等库恢复后重试

写进去的记录会出现在 prime 的记忆检索里（`scene` 为 `日记/<日期>` 或 `快照/...`），
所以装完之后用 prime 的记忆面板就能搜到日记内容。

## 安装

### 方式 A：从 GitHub 安装（推荐）

在 DSH 的设置 → 插件里，用 GitHub 规格安装：

```
github:shargritton/prime-diary
```

装好后确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含有 `dsh-prime-diary`，
然后重启宿主（或让宿主重新应用 bundles），客户端刷新页面即可看到设置里的「每日日记」页签。

### 方式 B：本地手动安装

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm add github:shargritton/prime-diary
```

再把 `dsh-prime-diary` 加进同一份 `package.json` 的 `dsh.profile.bundles` 数组
（只加依赖、不加 bundles 宿主不会加载），重启宿主生效。

## 使用

设置页 →「每日日记」：

- 顶部：启用、**固定生成时间**、生成间隔、上下文阈值、偷懒概率、字数范围、入库门槛、全自动开关
- 中部：会话列表，可勾选参与日记的会话（默认全部）
- 下部：草稿列表 → 详情可编辑、采纳、丢弃

触发方式：**固定时刻 + 锚点日**调度（默认每天 23:00，可改；每 N 天一次；锚点在你保存配置那天固定，自动生成后不回写锚点，所以时间不会漂），或某个未剔除会话的上下文占用超过阈值时提前触发。

「立即生成」不改变调度状态（不改 `lastRunAt` / `nextAt` / 锚点），随时点都不影响下一次自动生成的时间。

## 数据存放

全部在 `$DSH_HOME/prime-diary/` 下：

| 路径 | 内容 |
|---|---|
| `drafts/<date>.json` / `.md` | 草稿与候选记忆 |
| `diaries/<date>.md` | 已采纳的日记成品 |
| `outbox/<date>.json` | 待写入 prime 的载荷（`pending-write`），写入失败时留在这里 |
| `digests/` | 会话提炼产物 |
| `state.json` | 上次运行时间、偷懒记录、错误 |
| `config.json` | UI 里改的配置 |
| `backups/` | 写 prime 库前的备份（`VACUUM INTO`） |
| `debug.log` | 调试日志 |

## 卸载

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm remove dsh-prime-diary
```

并把 `dsh.profile.bundles` 里的 `dsh-prime-diary` 删掉，重启宿主。
`$DSH_HOME/prime-diary/` 里的数据不会自动删除，需手动清理。

## 已知限制

- 写入依赖 `dsh-prime-memory` 的 schema（当前对应 0.26.x）。插件**没有做版本探测**：prime 若改表，写入会直接报 SQL 错误，草稿会保留、载荷落在 `outbox/`，需要人工确认后用新表结构重试。装完建议先点一次设置页的「写入通道自检」。
- 依赖系统的 `sqlite3` 命令行；没有它会直接报 `spawnSync sqlite3 ENOENT`。
- 会话文件（`session.v4.jsonl.zstd`）来自 `dsh-reference-session-collector`，格式变更会导致解析失败，该会话被跳过并记日志。
- 日记取材只取 user/assistant 文本，不含 reasoning 与工具输出。
- 可选依赖 `@node-rs/jieba` 装不上不影响运行，只是分词退化、检索召回略差。

## License

MIT，见 [LICENSE](LICENSE)。

---

## 附：设计文档

### 设计目标

1. 写入方式：先草稿 + 手动采纳，稳定后再提供全自动开关
2. 触发：按间隔生成（最小 24 小时）＋按上下文占用百分比提前触发
3. 范围：可剔除不重要的会话（UI 勾选）
4. 风格：跟随会话语气自写，字数 10–500，可按概率偷懒；
   内容含第一人称、关键事件、情绪、未完成事项、吐槽、喜欢的东西

### 配置项

| key | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `dailyAt` | `23:00` | 固定生成时刻（HH:mm）；与间隔天数一起决定下次自动生成时间 |
| `scheduleAnchor` | 首次启用当天 | 调度锚点日（YYYY-MM-DD）；改时刻或间隔时重置为当天 |
| `intervalDays` | 1 | 生成间隔（天），1–`maxIntervalDays`；下次时间 = 锚点日 + N 天，落在 `dailyAt` 时刻 |
| `maxIntervalDays` | 7 | 间隔天数上限（UI 可选范围固定 1–7 天） |
| `contextThreshold` | 85 | 某会话上下文占用 ≥ 该百分比时提前触发（0=关闭） |
| `skipProbability` | 0.20 | 偷懒概率（0–1），偷懒则当天不写、不抽取 |
| `minChars` / `maxChars` | 10 / 500 | 日记字数范围；实际长度在范围内随机 |
| `importanceThreshold` | 0.6 | 候选记忆入库门槛 |
| `autoAdopt` | false | 稳定后再开；true 时跳过审阅直接入库 |
| `includedSessions` | null | 纳入日记的 session id 列表（null=全部） |
| `includeWorkspaces` | [] | 空=全部工作区 |
| `styleMode` | `adapt` | adapt=跟随会话语境；也可 `fixed` |
| `maxInputTokens` | 12000 | 单次送 LLM 的素材上限 |

### 数据流

```
~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd
        │  Node zlib.zstdDecompressSync（多帧一次解码）
        ▼
上次生成以来 user/assistant 文本（剔除 reasoning、tool 输出、被剔除会话）
        │  LLM：日记 + 候选记忆（重要度/类型/证据）
        ▼
drafts/<periodEnd>.json + .md  ──UI 审阅──►  采纳
                                              │
                              prime L1（scene=日记/日期）+ L2 日记场景
```

### 写入通道

优先级：① 复用 prime 的 `upsertL1` / `memport`，保证 FTS、场景索引、元数据一致；
② 若内部模块无法稳定导入，在单事务内写 `l1_records` + `l1_fts` + 必要元数据；
③ 均失败则只落日记文件 + 候选 JSON，采纳时提示手动导入。

### 风险与对策

- prime 升级改 schema：版本探测 + 启动自检，缺失列则只写文件并告警
- zstd 会话格式变更：解析失败跳过该会话并记日志
- token 成本：按会话截断、优先首尾消息、`maxInputTokens` 硬顶
- 隐私：只取 user/assistant 文本；默认脱敏密钥；不写 reasoning/tool 输出
