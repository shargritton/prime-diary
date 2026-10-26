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
| dsh-prime-memory | 已安装并启用；写入通道对应 0.26.x schema |
| 宿主依赖 | `@deepseek-ai/cordis` ^4、`@deepseek-ai/schemastery` ^3（由宿主提供） |

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

- 顶部：启用、生成间隔、上下文阈值、偷懒概率、字数范围、入库门槛、全自动开关
- 中部：会话列表，可勾选参与日记的会话（默认全部）
- 下部：草稿列表 → 详情可编辑、采纳、丢弃

触发方式：间隔到点（最小 24 小时，每 5 分钟检查一次），或某个未剔除会话的上下文占用超过阈值时提前触发。

## 数据存放

全部在 `$DSH_HOME/prime-diary/` 下：

| 路径 | 内容 |
|---|---|
| `drafts/<periodEnd>.json` / `.md` | 草稿与候选记忆 |
| `diaries/<periodEnd>.md` | 已采纳的日记成品 |
| `state.json` | 上次运行时间、偷懒记录、错误 |
| `config.json` | UI 里改的配置 |
| `backups/` | 写库前的备份 |

## 卸载

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm remove dsh-prime-diary
```

并把 `dsh.profile.bundles` 里的 `dsh-prime-diary` 删掉，重启宿主。
`$DSH_HOME/prime-diary/` 里的数据不会自动删除，需手动清理。

## 已知限制

- 写入依赖 `dsh-prime-memory` 的 schema（0.26.x）。prime 升级改表时插件会做版本探测：探测失败则只落文件、不写库，并在日志里告警。
- 会话文件（`session.v4.jsonl.zstd`）来自 `dsh-reference-session-collector`，格式变更会导致解析失败，该会话会被跳过并记日志。
- 日记取材只取 user/assistant 文本，不含 reasoning 与工具输出。

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
| `intervalDays` | 1 | 生成间隔（天），1–`maxIntervalDays`；1 天 = 24 小时 |
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
