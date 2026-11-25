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
    conductorSeatRegistry: /home/n8/.local/state/dsh-session-registry/state.json
```

`conductorSeatRegistry` (optional) names the conductor session registry's `state.json` (dsh-session-registry). A session that holds a conductor seat there — a key of its `opened` map — is never stopped, whatever its id. The registry seat is the role marker; there is no session-id pattern exemption. A missing or malformed file seats nobody.

The plugin counts the agent session's own steps, full provider token usage (including cache reads/writes), and identical canonical tool calls. The accounting boundary is reactive: one provider response can overshoot a token or repeated-call threshold, but equality does not admit another model step. At the next `agent/pre-step` after a limit trips, it appends `agent/runaway-stop`, cancels and awaits only the agent's owned live background jobs, and rejects the model step. Set an individual limit to `0` to disable it.

The plugin requires the host `ctx.jobs` registry. It does not reconcile external task databases; the dispatcher must observe the durable stop and terminally reconcile its own task row.
