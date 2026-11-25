# `@deepseek-ai/dsh-runaway-guard`

English | [中文](README.zh.md)

Preset-scoped hard limits for top-level agents. Mount this plugin only in agent presets that require bounded autonomous execution.

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

`conductorSeatRegistry` (optional) names the conductor session registry's `state.json` (dsh-session-registry). A session that holds a conductor seat there — a key of its `opened` map — is never stopped, whatever its id. The registry seat is the role marker; there is no session-id pattern exemption. A missing or malformed file seats nobody.

The plugin counts the agent session's own steps, its uncached token work, and identical canonical tool calls. `maxTokens` budgets uncached work only: input + output + cache writes (provider usage counts are disjoint, so input already excludes cached input). Cache reads are tracked and reported separately in the stop event (`cacheReadTokens`) but never count against a limit: a ~100k-context session re-reads its prefix every step, so a budget over cache reads stops normal ~100-step sessions. Two burst checks cover fast runaways: `maxTokensPerHour` caps uncached tokens in any rolling hour, and `maxDelegationsPerHour` caps delegation calls (`subagent`, `subagent_fork`, `subagent_claude_code`, `subagent_codex`, `workflow`, `ralph`) in any rolling hour; both default to `0` (off). The accounting boundary is reactive: one provider response can overshoot a token or repeated-call threshold, but equality does not admit another model step. At the next `agent/pre-step` after a limit trips, it appends `agent/runaway-stop`, cancels and awaits only the agent's owned live background jobs, and rejects the model step. Set an individual limit to `0` to disable it.

The plugin requires the host `ctx.jobs` registry. It does not reconcile external task databases; the dispatcher must observe the durable stop and terminally reconcile its own task row.
