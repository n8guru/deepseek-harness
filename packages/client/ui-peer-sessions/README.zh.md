# @deepseek-ai/dsh-client-ui-peer-sessions

[English](README.md) | 中文

Client 插件，轮询 `ctx.remote.dshHostDirectory.list()`，即由 [`@deepseek-ai/dsh-host-directory`](../../host/dsh-host-directory/README.md) 经现有 `/api` 通道发布的 Typert Remote，并把最新合并后的对端会话目录保存在 store 中。该 store 以 Context 服务 `ctx.dshPeerSessions` 提供，是用 [`@deepseek-ai/dsh-client-runtime`](../runtime/README.md) 的 `createSnapshotStore` 构建的 `SnapshotStore<DshPeerSessionsState>`。插件不注册 slot，也不渲染任何内容；[`@deepseek-ai/dsh-client-ui-workspace`](../ui-workspace/README.md) 读取该 store，在侧边栏渲染对端机器分组。

## 配置

将插件挂载在 `@deepseek-ai/dsh-host-directory`（Host 端）和 Remote 组合之后：

```yaml
- id: ui-peer-sessions
  name: '@deepseek-ai/dsh-client-ui-peer-sessions'
```

该插件没有配置项，并注入 `remote` 与 `remote.dshHostDirectory`。消费方通过 `ctx.dshPeerSessions` 共享该 store；不要再构造第二个 `createDshPeerSessionsStore()`，也不要再次轮询该 Remote，而未包含此插件的构建只是不显示对端分组。

## store 状态与轮询

`DshPeerSessionsState` 包含 `snapshot`（最近一次成功读取的 `DshHostDirectorySnapshot`，首次轮询完成前为 `undefined`）和 `lastPollFailed`。

`startDshPeerSessionsPoll` 在挂载时调用 `list()`，之后每 5 秒调用一次（`options.pollIntervalMs` 是测试用入口）。轮询成功时整体替换 `snapshot` 并清除 `lastPollFailed`。RPC 失败时只设置 `lastPollFailed`，不改动上一次良好的 `snapshot`，因此一次瞬时失败不会清空目录。对端层面的失败不是 RPC 失败：它们通过 Host 随 `snapshot.peers[].status` 送达。`dispose()` 会中止进行中的轮询，使迟到的结果被丢弃，而不是写入已销毁的 store。

## 待处理输入

当某个对端在 `dsh-host-directory` 中启用 `pollPendingInput` 时，部分 `snapshot.sessions[]` 行会带有只读的 `pendingInput`，类型为 `question` 或 `approval`，并从 Host 快照原样透传。消费方将其渲染为一条提示，写明所属 Host 并附带运维人员自行打开的深链接；本包没有任何写入对端会话的路径。

## 模型体验

无，因为这个仅限 Client 的目录轮询器不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **不渲染** —— 本包只发布 store；分组和深链接打开由消费方负责。
- **无退避** —— 持续失败的目录会以同样固定的 5 秒间隔继续轮询，这是可接受的，因为每次轮询只读取本 Host 已计算好的快照。
- **固定间隔** —— Client 间隔不可配置；实际新鲜度由 Host 的 `pollIntervalMs` 决定。
- **只读** —— store 不提供引导、回答或批准操作；引导对端会话只能通过打开所属 Host 自己的 origin 来完成。
