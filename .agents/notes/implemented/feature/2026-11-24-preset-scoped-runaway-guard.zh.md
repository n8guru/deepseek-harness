# Agent Note: 预设作用域失控防护

Status: implemented

[English](2026-11-24-preset-scoped-runaway-guard.md) | 中文

## 问题

现有 subagent 防护仅保护委派子 agent。顶层 `mesh-worker` 会话因此可能超过同一 token 预算后继续发起模型步骤，并在外部 `session.cancel` 后遗留自己拥有的后台进程。

## 决策

新增可选的 agent preset 插件 `@deepseek-ai/dsh-runaway-guard`。它复用现有会话用量统计实现，记录作用域准确的 `agent/runaway-stop` 事件，取消并等待受保护 agent 拥有的后台任务，然后拒绝下一个模型步骤。子 agent 继续使用 `subagent/guard-stop` 及现有结果语义。

限制值由插件配置验证。部署决定受保护的 preset 和具体数值；交互式 preset 不受影响。外部调度器仍负责依据持久化停止事件终结其任务记录。

## 考虑过的替代方案

**让所有顶层 agent 都经过 subagent 组合流程。** 未采用，因为顶层 agent 不经过该接缝；强制接入会把相互独立的 preset 策略与委派策略耦合起来。

**全局启用防护。** 未采用，因为交互式会话需要保留操作员指挥下的灵活性；preset 作用域能明确标出自主 worker 的边界。

**仅依赖外部用量 watchdog。** 未采用，因为它在采样用量越过阈值后才行动，且不能同步收束被停止 agent 所拥有的后台任务。

## 后果

自主 preset 现在可以在下一次模型请求前执行本地步骤、token 和重复调用上限，并在停止期间等待其后台任务结束。代价是每个受保护 preset 需要一个可选插件配置行，且调度器仍负责终结任务记录。
