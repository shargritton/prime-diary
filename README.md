# dsh-prime-diary — 设计草案 v0.1

为 `dsh-prime-memory` 增加"每日日记 + 重要记忆筛选 + 自动整理入库"的独立伴生插件。
不改 prime 源码；通过其数据/导入通道写入。

## 1. 用户需求（2026-10-25 确认）

1. 写入方式：**先草稿 + 手动采纳**，稳定后再提供"全自动"开关。
2. 触发：**按间隔生成**（最小 24 小时，可设为若干天），以及**按已用上下文百分比**提前触发。
3. 范围：可**剔除不重要的会话**，提供 UI 勾选。
4. 风格：跟随会话语气自写；字数 **10–500**；按**可配置概率偷懒**；
   内容含第一人称、关键事件、情绪、未完成事项、吐槽、喜欢的东西/事。

## 2. 配置项（默认值）

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
| `includedSessions` | null | 纳入日记的 session id 列表（null=全部；UI 勾选维护） |
| `includeWorkspaces` | [] | 空=全部工作区 |
| `styleMode` | `adapt` | adapt=跟随会话语境；也可 `fixed` |
| `maxInputTokens` | 12000 | 单次送 LLM 的素材上限 |

## 3. 数据流

```
~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd
        │  Node zlib.zstdDecompressSync（多帧一次解码）
        ▼
上次生成以来 user/assistant 文本（剔除 reasoning、tool 输出、被剔除会话）
        │  LLM：日记 + 候选记忆（重要度/类型/证据）
        ▼
drafts/2026-10-25.json + .md  ──UI 审阅──►  采纳
                                              │
                              prime L1（scene=日记/日期）+ L2 日记场景
```

## 4. 存储

- 插件数据目录：`$DSH_HOME/prime-diary/`
  - `drafts/<periodEnd>.json`：日记正文 + 候选记忆 + 元数据（含 periodStart/periodEnd）
  - `drafts/<periodEnd>.md`：人类可读草稿
  - `state.json`：触发记录、偷懒记录、最后运行时间
  - `config.json`：运行时配置（UI 修改）
- 日记成品：`$DSH_HOME/prime-diary/diaries/<periodEnd>.md`
- prime 侧：L1 `scene_name=日记/YYYY-MM-DD`，`source_id=diary-YYYY-MM-DD`，
  去重键 `diary-YYYY-MM-DD-<index>`；每日一个 L2 场景块。

## 5. UI（v0.1）

一个设置页 tab「每日日记」：

- 顶部：启用、每日时间、上下文阈值、偷懒概率、字数范围、入库门槛、全自动开关
- 中部：会话列表（标题 / 工作区 / 最后活动 / 消息数 / 估算 token / 剔除勾选）
- 下部：草稿列表（日期、字数、偷懒标记、候选条数）→ 详情页可编辑、采纳、丢弃

## 6. 触发规则

- 间隔触发：`nextAt = lastRunAt + intervalDays*24h`，插件每 5 分钟检查一次；
  到点且上次生成之后还没有新草稿 → 生成。最小间隔 24h。
- 覆盖区间：每次日记覆盖 `[lastRunAt, now)` 的会话内容（不是“当天”）；
  文件按结束日期命名，frontmatter 记录 `periodStart` / `periodEnd`。
- 间隔大于 1 天时：整段合成**一篇**日记（不按天拆分）。
- 上下文提前触发：每完成一个 turn，检查**未被剔除会话**的上下文占用；
  任一会话 ≥ `contextThreshold` 且本区间该会话未触发过 → 提前生成。
  提前生成成功即视为一次完整运行，`nextAt` 从此刻重新计算。
- 偷懒：先掷骰子；偷懒则写一条 `state.json` 记录并在 UI 显示本次「偷懒」，
  不产出草稿、不写入记忆，`nextAt` 顺延一个间隔。手动「补写」可覆盖。

## 7. 写入通道（待 spike）

优先级：
1. 复用 prime 的 memport / L1 写入模块（`upsertL1` / `memport`），保证 FTS、
   场景索引、元数据一致；
2. 若内部模块不可稳定导入：在单事务内写 `l1_records` + `l1_fts` + 必要元数据
   （需跟随 prime schema，锁 0.26.x 并做版本探测）；
3. 均失败则 v0.1 只落日记文件 + 候选 JSON，采纳时提示手动导入。

明确不做：不重新打开 prime 的模型写删门控；写入走插件宿主代码。

## 8. 风险与对策

- prime 升级改 schema：版本探测 + 启动自检（缺失列则只写文件并告警）。
- zstd 会话格式变更：解析失败跳过该会话并记日志。
- token 成本：按会话截断、优先首尾消息、`maxInputTokens` 硬顶。
- 隐私：只取 user/assistant 文本；默认脱敏密钥；不写入 reasoning/tool 输出。

## 9. 里程碑

- M0（本次）：会话解码 POC + 今日素材扫描 ✅
- M1：宿主插件骨架（配置、扫描、草稿生成、间隔/阈值触发）
- M2：UI（会话剔除 + 草稿审阅）+ 采纳写入 prime
- M3：全自动模式、周报/月报、检索质量调优
