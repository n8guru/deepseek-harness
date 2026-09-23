# @deepseek-ai/dsh-command-compact

[English](README.md) | 中文

通过 [`ctx.compaction`](../compaction/README.md) 提供面向用户的 `/compact` 压缩（compaction）控制。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此组合中的每个命令适配器都能发现并执行它，无需模型轮次。[排队手动压缩 Agent Note](../../../.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.md)拥有接纳、锁与持久性决策。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/compact` | 即使未达到自动压力，也摘要一段有效、平衡的较早范围；独立标记对 flush 后，报告被替换的历史项数量与估算 token 数。 |
| `/compact`，但没有可压缩历史 | `No compactable history yet.`：不会写入标记，也不会变更 surface。 |
| `/compact <anything>` | `Usage: /compact (no arguments)`：该命令不接受参数，也不会调用压缩后端。 |

该命令与后端无关，只依赖 `compactNow(agent, signal)`。调用该命令的 agent（智能体）就是操作的确切目标，发起分发的 UI 会通过 seam 转发取消信号。每次完成的调用都会记录执行器所属的纯日志事件对 `command/run` / `command/done`；两者都不进入模型历史。成功时，`command/done.sourceEventSeq` 会指明该事务的 `compaction/summary` 事件，让呈现层无须解析结果文本或假定两行相邻，即可将命令生命周期归并到对应检查点中。

预期的 `ManualCompactionError` 代码会成为稳定的直接错误：

| 代码 | 直接结果 |
|---|---|
| `busy` | `Compaction is unavailable because this process has an active compaction, or the agent is not idle.` |
| `changed` | `The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.` |
| `summary` | `Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.` |
| `commit` | `Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.` |
| `persistence` | `Compaction finished, but the session could not be saved.` |

busy 结果有意限定在进程范围内：活动的未匹配标记会阻塞，而早于最新 `session/end-seed` 的标记已陈旧，不会阻塞。意外实现故障会拒绝分发。取消仍具有最终决定权；后端会完成必需的闭合／flush 清理，命令内部以 `Compaction cancelled.` 结算，而命令执行器会因取消错误停止等待。插件处置会先注销 `/compact`，再等待所有已开始的处理器结算，因此根级 teardown 不会越过已中止命令的闭合或 flush 边界。

压缩运行期间提交的提示词仍会按 agent 的普通 FIFO 获得接纳，保留相同的身份与唤醒信息。它们仅在压缩的显式持久性检查点和接纳预留释放后启动。空闲注入的上下文不受阻塞：它可以记录在 `compaction/start` 与 `compaction/end` 之间，位置替换会使其在检查点之后保持可见。

## 组合

生产方注入 `commands` 和 `compact`。挂载命令注册表、一个后端与本插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
```

随附 `dsh` 基础配置将它挂载在 `compaction-basic` 旁，Web 客户端提供命令适配器。未组合命令适配器的自动化接口只保留自动压缩。

## 模型体验

### 用户 `/compact` 控制

#### 模型看到什么

斜杠输入与直接结果绝不会进入模型请求。已获接纳的压缩会另外在独立的 `compaction/* { turn: null }` 标记对内，用后端的 user 角色检查点替换一段较早范围。

#### Token 影响

命令生命周期不会增加模型 token。成功压缩会用一份带框架的摘要替换所选范围，从而减少后续请求；摘要生成本身需要一次辅助请求。

#### KV Cache 影响

命令发现与簿记不会影响缓存。已获接纳的 surface 替换会从第一个被遮蔽的历史 token 起使复用失效。

## 可选 hand_forward 工具

仅在目标 conductor 的组合中设置 `config.handForward: {}`，并提供 `tools`、`agents`、`sessions`、`llm`、`tokenMeter` 和 `fs`。默认组合不启用该工具。参数为 `{ reason, baton_path? }`；配置 `batonPath` 默认为 `/home/n8/forge-agent-os/tools/CONDUCTOR-BATON.md`，`maxBatonBytes` 默认为一 MiB。缺失、非普通文件、空白、非法 UTF-8、超限文件以及重复待执行调用均被拒绝。

验证与审计完成后立即返回 `{ scheduled: true, generation, at_context_pct, context_tokens, context_capacity, provider, model }`，不等待压缩。百分比来自 tokenMeter 请求压力与日志中准确模型的容量（尚无请求时使用 agent options），不是累计计费。容量未知或测量期间模型变化时拒绝。只读预检（resolve、stat、read、模型查询）从调用开始共享一个 idleTimeoutMs 截止时间，与之后的空闲等待分别计时。每个 await 同时等待结果、超时、调用者取消或插件关闭，即使后端忽略取消也会退出。超时返回可见工具错误 hand_forward abandoned: preflight timed out 并写主机日志，不创建代号或审计文件。从入口跟踪接纳过程，拒绝时释放本地 pending。迟到的成功或拒绝仅被观察，不继续验证、取得所有权或执行动作。审计取得与发布刻意不使用只读竞速，写入未结束时绝不解锁。

工具等待整个 agent 空闲，再在同一 Agent/Session 上调用现有 `compactNow`。成功后（包括没有可压缩历史）仅排队一次普通下一轮提示：“Baton generation start. Read <baton_path> and Studio slug=conductor-relay, then give Nate one short state update.” 已有消息保持普通顺序；不优先处理 bootstrap，也不清空上下文。子任务路由、配置、重放不变。

审计历史与 pending 状态共同保存在 `<DSH_HOME>/hand-forward/<sha256(session-id)>/baton-state.json`（默认 home 为 `~/.dsh`），部署可用 `auditDirectory` 覆盖。每次变更先写私有临时文件并 fsync，再原子 rename 并 fsync 目录，避免半条记录或不匹配的 pending 状态。记录含代号、会话、时间、provider/model、原始字节 SHA256、原因与状态。相邻 `baton-mutex.sqlite` 上的 node:sqlite BEGIN IMMEDIATE 写入预留贯穿整个操作（包括空闲等待与 rename），由内核排除竞争所有者；它不是会话存储。延迟或暂停的活跃所有者不会因时间到期被取代，进程死亡释放预留。版本 2 快照持久化单调递增的 owner_epoch，pending 与日志也携带该值。每次写入在预留内重新读取并比较 epoch，压缩及 bootstrap 前同样检查，比较与 rename 之间不能被正常继任者抢占。`staleMs` 默认 120000、最小 5000，仅限制已失主 pending 的恢复年龄；取得预留后才清理旧 pending，记录原因且不重放。未知或旧快照版本拒绝，不在线迁移。要求本地文件系统支持可靠 SQLite 锁；主机可能持锁时不得删除或替换 mutex 文件。审计与会话 inbox 仍为独立事务，不承诺跨崩溃的 exactly-once；会话格式与重放不变。

没有按钮、自动交接节奏计时器、不活跃策略或模型切换。bootstrap 消耗正常一轮；压缩可能调用摘要模型。失败写审计，不自动重试；压缩失败不排队 bootstrap，但入队后的失败可能仍已交付。文件之后可以变化，哈希仅标识接受时的版本。`idleTimeoutMs` 默认 600000，限制已排期的空闲等待；到期记录 abandoned，显示插件来源通知 `hand_forward abandoned: session never idle`（不唤醒轮次），审计写入结束后释放预留，迟到的空闲回调不能压缩。`watchdogMs` 默认 300000，对压缩和 bootstrap 阶段分别告警一次；bootstrap 包括等待整个 agent 恢复空闲。日志、审计和可见通知共同告警，绝不因超时解除运行中副作用的锁。`disposeTimeoutMs` 默认 10000，限制本插件的销毁等待；协作中止未完成时告警并返回，但保留预留。三个时长必须是 Node 计时器范围内的正安全整数毫秒。通知使用现有插件来源消息，会进入模型上下文，不改变事件格式或重放语义。计时器需要事件循环运行；进行中的文件写入不能因超时解锁。

监督恢复：在外部停止新任务接纳，记录确切主机、会话、审计路径、epoch、generation 与阶段。取得操作员明确授权后通过现有 supervisor 重启该 DSH 主机，并确认旧 PID 已退出；其他会话可能中断。不得删除 mutex 或手改 pending。重启后检查快照及会话压缩/bootstrap 事件，在新预留下达到 staleMs 才能放弃中断的 pending。确认下次 epoch 严格递增、旧 generation 全部保留；不盲目重放可能已交付的 bootstrap。这里只限制本插件处置，其他插件仍可能阻塞根级关闭。

## 可选 context nudge

仅在目标 conductor 的组合中设置 `config.contextNudge: {}`，并提供 `systemPrompt` 与 `sessionProjections`。默认组合不启用。插件注册一个动态 prompt-context 条目（`compaction:context-nudge`），在作用域内每轮预装配时运行，最多贡献一行短提示：

- 低于 `warnPct`（默认 25）：无任何输出——零 token、无提示；
- 达到 `warnPct`：`context 26% — look for a natural break; hand_forward at 30%`；
- 达到 `actPct`（默认 30）：`context 31% — call hand_forward at the end of this turn (baton: tools/CONDUCTOR-BATON.md)`；
- 40 轮（`maxTurnsWithoutForward`）未调用 `hand_forward`：提示轮次数的陈旧行；
- 本轮之前空闲超过 90 分钟（`idleGapMs`）：`resuming after idle; re-read baton state first`。

压力取自主机的 `contextPressure` 投影（`pressureTokens / contextWindow`，与 Web 客户端同源），不自行重算。轮次位置、交接陈旧度与空闲间隔只读已提交会话事件。提示绝不压缩、绝不调用 `hand_forward`；唯一的执行者仍是上面的 `handForward`。全部阈值均为校验配置项：`warnPct`、`actPct`、`maxTurnsWithoutForward`、`idleGapMs`、`batonPath`。

Conductor 启用方式（preset 或 profile 补丁层，会整体替换该行配置）：

```yaml
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
  config:
    handForward: {}
    contextNudge: {}
```

## 已知限制与暂缓事项

- **仅限空闲状态**：当一个轮次或已获接纳的唤醒提示词拥有优先权时，`/compact` 会报告 `busy`；命令本身不会排队。
- **不接受范围或策略参数**：无参数形式使各命令适配器的行为保持稳定。显式范围仍由编程接口 `compactRegion()` 处理。
- **仅限命令适配器**：没有 `ctx.commands` 的接口无法调用该命令，只能依赖自动压力压缩。
