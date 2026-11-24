# Agent Note: Preset-scoped runaway guard

Status: implemented

English | [中文](2026-11-24-preset-scoped-runaway-guard.zh.md)

## Problem

The existing subagent guard protected only delegated children. A top-level `mesh-worker` session could therefore exceed the same token budget, continue issuing model steps, and leave an owned background process alive after an external `session.cancel`.

## Decision

Add `@deepseek-ai/dsh-runaway-guard` as an opt-in agent-preset plugin. It reuses the existing session-accounting implementation, records the accurately scoped `agent/runaway-stop` event, cancels and awaits jobs owned by the guarded agent, then rejects the next model step. Child agents retain `subagent/guard-stop` and their existing result semantics.

Limits are validated plugin configuration. Deployments choose the guarded presets and values; interactive presets remain unchanged. External dispatchers remain responsible for reconciling their task rows from the durable stop.

## Alternatives considered

**Extend the subagent composition to every top-level agent.** Rejected because top-level agents are not composed through that seam, and forcing them through it would couple independent preset and delegation policies.

**Apply the guard globally.** Rejected because interactive sessions need operator-directed flexibility; preset scope makes the autonomous worker boundary explicit.

**Rely only on the external usage watchdog.** Rejected because it acts after sampled usage crosses a threshold and cannot synchronously quiesce jobs owned by the stopped agent.

## Consequences

Autonomous presets can now enforce local step, token, and repeat-call limits before the next model request and settle their background jobs during the stop. The cost is one opt-in plugin row per guarded preset and continued dispatcher responsibility for terminal task reconciliation.
