# @deepseek-ai/dsh-session-successor

[English](README.md) | 中文

为 cadence 交接（hand-forward）提供持久的旧会话→继任会话谱系。新一代接手后，旧会话日志中恰好写入一条仅日志 `session/successor` 事件，内容为 `{successorSessionId, successorGeneration, handoffId}`。`successor` 投影键提供该事实，因此 `session.list` 行、历史尾页和 mux `session/projection` 帧无需专门的线路即可携带它。旧会话归档后、页面重载或重连后，该事实依然可见。

## 服务：`SessionSuccessorService`（ctx 键：`sessionSuccessor`）

- `get(session)` 折叠第一条 `session/successor` 事件，没有则返回 `null`。
- `record(old, request, options?)` 仅在继任会话就绪时追加事实。就绪包含两部分。其一，继任会话日志中已有一条已提交、原因为 `completed` 的 `turn/end`；检查前会先 flush 继任会话。仅创建会话、接受提示或有轮次正在运行都不够。其二，当前指针解析结果恰好指向该继任会话。该值来自调用方根据 Forage conductor 指针解析出的 `request.pointerSessionId`；若部署提供了实时解析器，则改用 `options.resolvePointer()`。追加后，`record` 返回前会 flush 旧会话日志，因此事实在任何归档之前已持久化。
- 同一旧会话的声明按顺序串行执行，并以 `handoffId` 保证幂等：同一次交接返回 `status: 'existing'`。每种拒绝都抛出 `SessionSuccessorError`，旧日志保持不变，因此旧会话仍保持选中且不被归档。拒绝码为 `invalid`、`old-not-live`、`self-link`、`conflict`（已存在不同的继任或交接）、`cycle`（继任会话的实时谱系回到旧会话）、`wrong-workspace`（header cwd 不同，或可选的 `sameWorkspace` 钩子否决）、`successor-not-live`、`successor-not-ready` 和 `pointer-mismatch`。

不变量伴生插件会拒绝第二条 `session/successor` 事件和自链接，无论写入者是谁。

## 组合

由 base bundle 挂载，位于 `session-title` 旁。投影单元仅在组合了投影注册表时生效。可由智能体调用的写入方是 `@deepseek-ai/dsh-command-compact` 的可选 `record_successor` 工具，随 `handForward` 一起挂载。它在持久追加后归档旧会话。Web 客户端跟随逻辑位于 `@deepseek-ai/dsh-client-ui-conversation`（`successor/follow.ts`）。

## 模型体验

无，因为该插件只追加并折叠仅日志的 `session/successor` 事件，不触及任何提示、消息、schema、流或工具结果；写入它的可选 `record_successor` 工具由 `@deepseek-ai/dsh-command-compact` 记录。

#### KV Cache 影响

无；该插件从不组装或发送提供方请求。

## 已知限制与延后工作

- 环检测只遍历实时会话。仅由冷的、未加载会话持有的谱系链接不会被跟随。
- 主机不调用 Forage。除非部署提供 `resolvePointer`，否则指针声明来自调用方的解析结果。
- Hub 滑出面板（studio-dashboard 35）自行跟随 Forage conductor 指针，从不读取此谱系。
