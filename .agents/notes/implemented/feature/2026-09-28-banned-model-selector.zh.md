# Agent Note: Canon R20 banned models leave the selector

Status: implemented

[English](2026-09-28-banned-model-selector.md) | 中文

## Problem

Nate 已批准的 board #4 N3a（2026-09-25）与 Canon R20 将 Claude Opus 5、全部 GPT 5.6 id、GPT 5.5、Fable 5、Grok Build 和 Claude Haiku 从 runner 中退役。Forage 已在 mint/claim 拒绝这些 pin（`BANNED_MODEL_RE` / `is_banned_step_pin`）。DSH 目录仍通过 `session.models` / `llm.models` 公布它们，且 `session.selectModel` 接受任何适配器可解析的 id，因此 GUI 和 mesh 的 `selectModel` 仍可能落到被禁启动器上。Fable 5.1 仍是操作者显式 pin，必须保持可选，但绝不能成为 Agent 默认值。

## Decision

Host 网关拥有选择器约定。`buildModelCatalog` 在适配器列出之后从每个提供方分组中剔除 Canon R20 禁用 id，与 forage 的 `BANNED_MODEL_RE` 对齐（全匹配、大小写不敏感、去掉末尾 `[1m]`，并尝试最后一个斜杠分段，使 `grokheavy/grok-build` 命中）。`claude-opus-5-5` 不是 `claude-opus-5`。Fable 5.1（`claude-fable-5-1`、`fable-5.1`、`fable-5-1`）仍留在分组中。

`session.selectModel` 在请求或解析后的 id 被禁用时，以 `model-unavailable` 和 Canon R20 说明拒绝，不让 `resolveCallConfig` 把它写成会话选择。显式的 Fable 5.1 切换仍作用于该会话，且不会写入 `saveDefaultModelSelection`，因此不能成为部署默认值或 mesh 继承的种子。

## Alternatives considered

**只在 `settings.yaml` / 现役 `llm-pi-ai` 模型列表里过滤。** 否决：选择器由每个已注册适配器组装，而不是一份设置文档，且 `selectModel` 仍接受未列出的 id。改 forge 本机设置既无法拒绝 mesh 调用，也无法随 DSH 源码走。

**用新的 local-mod 插件拦截 `session.models`。** 否决：Host 已经拥有目录组装和选择；第二个所有者会与网关竞态，并漏掉 `llm.models`。

**把 Fable 5.1 也从选择器禁用。** 被 N3a 否决：操作者仍可按名称 pin。隐藏它会迫使走未列出的裸切换。

## Consequences

即使适配器仍能服务这些 id，禁用项也会从建议目录消失；日志里已经记下某一项的会话保留该当前选择，不会被改写。Mesh 和 GUI 对禁用 id 的 `selectModel` 以可读说明失败关闭。Fable 5.1 仍是仅限操作者的会话 pin。在已批准的合并 DSH 重启之前，现役 GUI 不变；在此之前该变更只存在于隔离分支。

## Testing

`packages/host/apiproxy/tests/api-proxy-models.spec.ts` 断言禁用 id 不出现在 `session.models` 中，`selectModel` 以 Canon R20 说明拒绝每一项，Fable 5.1 仍列出且可选，且该选择不会被存为默认值。
