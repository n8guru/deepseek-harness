# @deepseek-ai/dsh-host-directory

[English](README.md) | 中文

`DshHostDirectoryService` 运行在 `dsh web` Host 内，以服务器到服务器的方式轮询一份静态配置的对端 Host 列表。每次轮询向对端 POST `/api/session.list`（API Proxy 方法 `session.list`，payload 为 `{}`），这与对端自己的浏览器 Client 调用的是同一个 wire 端点；返回的行被合并为一份快照，并带有各对端声明的 `machine` 标签。快照以 Typert Remote `dshHostDirectory/list` 发布，Client 插件通过现有的共享 `/api` 通道读取。本包不新增 wire 协议、不做中继，也不向任何对端会话写入。

## 配置

将插件与 [`plugin-inventory`](../plugin-inventory/README.md) 一起挂载，并置于 API 网关之前：

```yaml
- id: dsh-host-directory
  name: '@deepseek-ai/dsh-host-directory'
  config:
    machine: forge
    pollIntervalMs: 5000
    peers:
      - machine: n8razer
        authority: 100.102.77.86:3080
        pollPendingInput: false
```

`machine` 是本 Host 在目录中的标签，默认为 `os.hostname()`。`pollIntervalMs` 默认为 5000，下限为 1000。每个对端包含 `machine`、`authority`，以及可选的 `scheme`（默认 `http`）、可选的 `sessionCookie` 和可选的 `pollPendingInput`。这三个顶层字段都是普通的插件配置：修改条目会重新加载插件，由新值重建对端表，无需重启 Host。

## 对端访问

rc.8 的 `/api` 路由由针对对端受信任 Host 的 Host 头检查把守（loopback、局域网字面地址，或已声明的 `--trusted-host`），而不是认证层。只要本 Host 的 authority 位于对端的受信任 Host 之中，对端就会放行轮询，因此轮询不发送任何凭据。`sessionCookie` 是可选的透传字段，会原样作为 `Cookie` 头转发，通常省略；它被标记为 secret，配置界面不会读回它。

不可达的对端会被如实报告，而不是被隐藏。它在 `list()` 中的行带有 `status: { state: 'unreachable', message }`，并注明原因（网络错误、`401`/`403` 拒绝、非 2xx 状态码或错误结果）；它的会话行会被清空，因此本 Host 无法确认的会话绝不会显示为存活。一个对端的失败不会阻塞其他对端的轮询。`list()` 本身不执行 I/O，只返回上一次轮询的结果。

## 待处理输入分类

设置 `peers[].pollPendingInput: true` 后，每个 tick 会对每个会话多发一次 `POST /api/session.history`（`maxMessages: 20`）。随后 `classifyPendingInput` 会把最近一个尚未解决的人工输入请求作为 `pendingInput` 报告在该会话行上：即一个未结束的 `ask_user_question` 工具调用，或一个没有对应 `approval/decided` 的 `approval/asked`。问题优先于审批。没有待处理项的会话不带 `pendingInput` 键。某次 history 读取失败时，只会让该会话在本 tick 缺少分类，不会把对端标记为不可达。该选项默认关闭。

## allow-remote-steer 门禁

引导（steer）对端会话，意味着在其所属 Host 自己的 origin 上打开它，由那里的 composer 发出常规写入 RPC。本包在该所属 Host 上增加按会话的选择加入开关，默认关闭，并通过 `ctx.connection.rpc.guard('/api', ...)` 强制执行。

- **远程与所有者。** `Host` authority 不是 loopback 的请求属于远程请求，必须已选择加入；loopback 请求是坐在键盘前的所有者，永远不受限制。
- **受限动词。** `session.prompt`、`session.updateQueue`、`session.cancel`、`session.selectModel`、`session.fork` 与 `session.rename`（同时列出 `session/...` 写法），以及选择加入的设置端点本身。读取操作以及审批和提问的回答通道不受限制。
- **选择加入。** Remote `dshHostDirectory/allowRemoteSteer({ sessionId })` 与 `dshHostDirectory/setAllowRemoteSteer({ sessionId, allow })` 分别用于读取和修改它。远程 origin 无法调用设置端点。状态保存在内存中，因此 Host 重启会让每个会话回到关闭状态。
- **mesh-pump 会话永不具备资格。** 会话 id 以 `session-mesh-` 开头，或 prompt 的 rpcId 以 `mesh-dispatch-` 开头，该会话即被标记为 pump 所有：设置端点会拒绝它，已有的选择加入也会被撤销。
- **拒绝。** 被拒绝的 steer 会以 `internal` RPC 错误的形式到达调用方，其消息以 `dsh-host/steer-denied:` 开头。

## 模型体验

无，因为这个仅限 Host 的目录轮询器不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **静态对端列表** —— 对端由运维人员声明，没有自动发现，例如借助 `tailscale status --json`。
- **仅轮询** —— 对端上开始或结束的会话会在一个 `pollIntervalMs` 窗口内出现，而不是即时出现，并且轮询只读取 `session.list` 的第一页。
- **通用错误码** —— rc.8 把任何抛出的错误折叠为封闭的 `internal` RPC 码，因此 `dsh-host/steer-denied` 只能作为消息前缀传递。
- **只读列表** —— 本包从不打开、引导或回答对端会话；引导只能通过打开所属 Host 自己的 origin 来完成，并受 allow-remote-steer 门禁约束。
- **待处理输入尽力而为** —— 只检查最近 20 条 history 消息，且摘要文本未经截断或清理，因此位于不受信任界面的消费方应当限制其显示的内容。
- **对端必须信任本 Host** —— 受信任 Host 中不包含本 Host authority 的对端会拒绝轮询，其行显示为 `unreachable`。
