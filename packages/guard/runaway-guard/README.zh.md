# `@deepseek-ai/dsh-runaway-guard`

[English](README.md) | 中文

面向顶层 agent 的预设作用域硬限制。仅在需要限制自主执行的 agent preset 中挂载此插件。

```yaml
- id: runaway-guard
  name: '@deepseek-ai/dsh-runaway-guard'
  config:
    maxSteps: 100
    maxTokens: 10000000
    maxRepeatCalls: 12
    jobSettleTimeoutMs: 30000
    conductorSeatRegistry: /home/n8/.local/state/dsh-session-registry/state.json
```

`conductorSeatRegistry`（可选）指向 conductor 会话注册表的 `state.json`（dsh-session-registry）。在其中持有 conductor 席位（即 `opened` 映射中的键）的会话永不被停止，与会话 id 无关。注册表席位就是角色标记；不存在按会话 id 模式的豁免。文件缺失或格式错误时不豁免任何会话。

插件统计该 agent 会话自身的步骤、完整提供商 token 用量（包括缓存读写）以及参数规范化后完全相同的工具调用。统计边界是响应式的：单次提供商响应可能越过 token 或重复调用阈值，但达到等值后不会再允许新的模型步骤。触发限制后的下一个 `agent/pre-step` 会追加 `agent/runaway-stop`，仅取消并等待该 agent 自己拥有的后台任务停止，然后拒绝新的模型步骤。将某项限制设为 `0` 可单独禁用。

插件依赖宿主的 `ctx.jobs` 注册表。它不会更新外部任务数据库；调度器必须观察持久化停止事件并终结自己拥有的任务记录。
