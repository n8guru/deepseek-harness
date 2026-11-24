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
```

插件统计该 agent 会话自身的步骤、完整提供商 token 用量（包括缓存读写）以及参数规范化后完全相同的工具调用。触发限制后的下一个 `agent/pre-step` 会追加 `agent/runaway-stop`，取消并等待该 agent 的后台任务停止，然后拒绝新的模型步骤。将某项限制设为 `0` 可单独禁用。

插件依赖宿主的 `ctx.jobs` 注册表。它不会更新外部任务数据库；调度器必须观察持久化停止事件并终结自己拥有的任务记录。
