# `@deepseek-ai/dsh-runaway-guard`

English | [中文](README.zh.md)

Preset-scoped hard limits for top-level agents. Mount this plugin only in agent presets that require bounded autonomous execution.

```yaml
- id: runaway-guard
  name: '@deepseek-ai/dsh-runaway-guard'
  config:
    maxSteps: 100
    maxTokens: 10000000
    maxRepeatCalls: 12
    jobSettleTimeoutMs: 30000
```

The plugin counts the agent session's own steps, full provider token usage (including cache reads/writes), and identical canonical tool calls. At the next `agent/pre-step` after a limit trips, it appends `agent/runaway-stop`, cancels and awaits the agent's live background jobs, and rejects the model step. Set an individual limit to `0` to disable it.

The plugin requires the host `ctx.jobs` registry. It does not reconcile external task databases; the dispatcher must observe the durable stop and terminally reconcile its own task row.
