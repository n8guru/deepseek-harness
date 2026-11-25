# `@deepseek-ai/dsh-runaway-guard`

[English](README.md) | 中文

面向顶层 agent 的预设作用域硬限制。仅在需要限制自主执行的 agent preset 中挂载此插件。

```yaml
- id: runaway-guard
  name: '@deepseek-ai/dsh-runaway-guard'
  config:
    maxSteps: 300
    maxTokens: 600000
    maxTokensPerHour: 500000
    maxDelegationsPerHour: 20
    maxRepeatCalls: 12
    jobSettleTimeoutMs: 30000
    conductorSeatRegistry: /home/n8/.local/state/dsh-session-registry/state.json
```

`conductorSeatRegistry`（可选）指向 conductor 会话注册表的 `state.json`（dsh-session-registry）。在其中持有 conductor 席位（即 `opened` 映射中的键）的会话永不被停止，与会话 id 无关。注册表席位就是角色标记；不存在按会话 id 模式的豁免。文件缺失或格式错误时不豁免任何会话。

插件统计该 agent 会话自身的步骤、未缓存的 token 用量以及参数规范化后完全相同的工具调用。`maxTokens` 只计未缓存的工作量：输入 + 输出 + 缓存写入（提供商用量各项互不重叠，输入已不含缓存输入）。缓存读取会单独统计并在停止事件中报告（`cacheReadTokens`），但从不计入任何限制：约 100k 上下文的会话每一步都会重读前缀，若把缓存读取计入预算，正常的约 100 步会话就会被停止。两项突发检查覆盖快速失控：`maxTokensPerHour` 限制任意滚动一小时内的未缓存 token，`maxDelegationsPerHour` 限制任意滚动一小时内的委派调用（`subagent`、`subagent_fork`、`subagent_claude_code`、`subagent_codex`、`workflow`、`ralph`）；两者默认均为 `0`（关闭）。统计边界是响应式的：单次提供商响应可能越过 token 或重复调用阈值，但达到等值后不会再允许新的模型步骤。触发限制后的下一个 `agent/pre-step` 会追加 `agent/runaway-stop`，仅取消并等待该 agent 自己拥有的后台任务停止，然后拒绝新的模型步骤。将某项限制设为 `0` 可单独禁用。

插件依赖宿主的 `ctx.jobs` 注册表。它不会更新外部任务数据库；调度器必须观察持久化停止事件并终结自己拥有的任务记录。
