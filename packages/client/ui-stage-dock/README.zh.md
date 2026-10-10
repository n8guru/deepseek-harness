# @deepseek-ai/dsh-client-ui-stage-dock

[English](README.md) | 中文

舞台侧栏：钉在框架右缘的一块面板，内嵌一个 [Forage](https://forage.ink) 舞台页 iframe，外加一个会话头部控件负责它的显示与隐藏。舞台页本身——那块深色满幅的视觉画板，卡片弹入、可拖动、彼此连线，并在一条有序 SSE 流上高亮脉冲——完全属于它自己；本包只贡献绑定与显隐，别无其他。行为由 [DSH 舞台侧栏 Agent Note](../../../.agents/notes/implemented/feature/2026-09-26-dsh-stage-dock.md) 规定。

面板是 [`shell.overlay`](../ui-layout/README.md) 里的一个条目——那是横跨整个框架的浮层，位于所有列之上、且在它们的滚动容器之外。让侧栏不受 transcript 滚动影响的是这个座位，而不是某段样式：面板从不在滚动的对话容器内部，因此没有任何滚动位置可以传染给它。浮层本身可穿透点击，并把指针事件授予它的直接子节点，所以侧栏自己的外框可交互，而浮层其余部分仍让底下的应用可达。它的 order 取 100，排在命令弹层之后，因为一块常驻侧栏不该盖住操作者刚刚打开的浮层。

DSH 会话 id 决定不了 Forage 会话 id，线路上也没有任何东西把二者关联起来，所以绑定由操作者提供：面板自己的头部有一个数字输入框和一个「绑定」动作，与 `stage open` 为 agent 做的事对应。用另一个 id 再绑定一次就是编辑绑定的方式。指代不到会话的值——空白、单词、小数、零——会被忽略，当前绑定原样保留。绑定会在同一步显示侧栏；隐藏侧栏则保留绑定，所以再次打开永远不会重新追问。

绑定与显隐都按会话记录，因为两个会话完全可以各看一块舞台；两者都会持久化：重载丢掉的显隐状态等于一块悄悄脱钩的侧栏。存储是 `dsh.stage-dock.v1` 下的一条 `localStorage` 记录，store 引擎在 rehydrate 时不做校验——所以由读取方归一化，形状不再匹配的行读作一块隐藏且未绑定的侧栏，而不是变成一个畸形的 iframe URL。为什么是浏览器本地而非宿主侧 sidecar，见下方「已知限制与暂缓事项」。

iframe 恰好保留舞台页需要的两项能力：`allow-scripts`，因为画板运行自己的渲染器；`allow-same-origin`，因为它要读自己的 `forage.ink` 数据流。它不获得弹窗、顶层导航和表单提交。侧栏指向线上的 Forage 部署，而不是本仓库提供的任何东西：charter 让舞台独立于它的宿主，所以侧栏只是一个观看者。

两个条目共享同一个 controller 实例，因此头部控件与面板读写的是同一个事实。样式只用 token，并由 `tests/styles.client.spec.ts` 对着主题样式表断言；文案走本包自己的 `stageDock` locale 命名空间。

## 模型体验

无。本包为人类渲染一个由操作者选定的外部页面，不触及 prompt、消息、schema、流或工具结果。模型通往同一块舞台的路径是它本来就会调用的 Forage 写入端点；这块侧栏对它完全不可见，关掉侧栏也不改变任何模型输入。

#### KV Cache effect

无；本包从不组装或发送 provider 请求。

## 已知限制与暂缓事项

- **绑定是浏览器本地的，不是宿主侧的会话 sidecar。** 步骤要求的是 DSH 会话元数据，而持久化的宿主路径确实存在——由本包 node 半边注册一个 settings 命名空间，浏览器半边经 `ctx.settingsScope` 写入。否掉它的理由是功能性的，不是工作量：`SettingsScopeBinder` 用 `connection.isLoopback ? 'host' : 'memory'` 构造它的 controller，而在 `'memory'` 模式下每一次写入都立即 resolve、根本不上线路。本部署是通过 Tailscale 与 LAN authority 访问的（`dsh web --trusted-host …`），所以 settings 支撑的绑定会恰好在正在使用的那条访问路径上悄悄不持久化，却还报告成功。`localStorage` 记录在任何 authority 上都能持久化。代价是绑定不会随操作者去另一个浏览器或设备，宿主也读不到它；当这两点中任一项成为需求时，升级路径是一个 Remote 服务背后的按 Session storage-domain sidecar，即 [`message-feedback`](../../feedback/message-feedback/README.md) 的形状。
- **没有任何东西去核对一个已死的会话。** 对应 Forage 会话已被删除的 id 仍会渲染：侧栏在内嵌之前不去探测舞台 URL，所以操作者看到的就是 `forage.ink` 为那个 id 返回的东西。校验绑定会让侧栏依赖舞台的可用性，而这正是 charter 那句「舞台从不依赖它的宿主」的另一半所要避免的耦合。
- **一个会话一块舞台。** 一个会话最多绑定一个会话 id，面板宽度由样式表固定，不可拖拽。
- **舞台 origin 是一个常量。** 第二个 Forage 部署会把它变成一个 `DSH_CLIENT_*` 构建值；今天只有一个。
