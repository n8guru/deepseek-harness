# Agent Note: DSH Stage dock

Status: implemented

[English](2026-09-26-dsh-stage-dock.md) | 中文

## Problem

Forage 在 `/stage/<conversation_id>` 提供一个舞台页：一块深色满幅的视觉画板，对象弹入、可拖动、彼此连线并脉冲高亮，由一个写入端点和一条有序 SSE 流驱动，因此渲染方就地打补丁、永不刷新。Agent 可以在回复过程中把一张图放到那块画板上。看着 DSH 对话的操作者要看到它就得离开会话去开浏览器标签页，而标签页是错的地方：画板的意义恰恰在于线程继续滚动时它留在原处。一块随 transcript 滚走的面板并不比标签页更好。

有两个事实让这件事不只是「加一个 iframe」。舞台由 Forage 会话 id 寻址，而没有任何 DSH 会话能决定它——线路上没有任何东西把二者关联起来，所以这个映射是必须被捕获并保存下来的操作者知识。另外，面板必须可证明地位于对话滚动容器之外，而不只是被样式做得看起来固定。

## Decision

一个客户端插件包 `packages/client/ui-stage-dock`，在一个 controller 之上贡献两个 slot 条目。

面板是 `shell.overlay` 里的一个条目——ui-layout 声明的、位于所有列之上且在它们滚动容器之外的横跨框架浮层。这个座位**就是**不受滚动影响这一性质本身：面板从不是滚动的对话容器的后代，因此没有任何滚动位置能传染给它，而这一论断由一个注册测试断言，而非由某段样式表。浮层可穿透点击并把指针事件授予它的直接子节点，因此侧栏外框可交互，而浮层其余部分仍让底下的应用可达。该条目 order 取 100，排在 ui-commands 弹层的 1 之后：一块常驻侧栏不该盖住操作者刚刚打开的浮层。

控件是 `conversation.session.header.actions` 里的一个条目，与 20 位的后台任务列表相邻并排在其后——过程性工作先读，视图控件后读。它无条件渲染，因为尚无绑定的会话恰恰是需要这个入口的会话。

绑定由操作者提供，通过面板自己头部的一个数字输入框和一个「绑定」动作——与 `stage open` 为 agent 执行的是同一件事。用另一个 id 再绑定一次即为编辑绑定。指代不到会话的值（空白、单词、小数、零、非安全整数）会被忽略，当前绑定原样保留。绑定在同一步显示侧栏；隐藏保留绑定，因此再次打开永不重新追问。

绑定与显隐都按会话记录——两个会话完全可以各看一块舞台——且两者都持久化，因为重载丢掉的显隐状态等于一块悄悄脱钩的侧栏。状态是一条 `createSnapshotStore` 记录，以 `dsh.stage-dock.v1` 持久化到 `localStorage`。引擎 rehydrate 时不做校验，因此 `entryOf` 在读取时归一化：形状不再匹配的行读作一块隐藏且未绑定的侧栏，而不是变成一个畸形的 iframe URL。

一个 `StageDockController` 实例服务两个注册，经 inject face 的保留 `hooks` 隔间交给各方，因此控件与面板读写同一个事实。本插件不发任何 RPC，node 半边是惯常的空 `apply`。

iframe 指向 `https://forage.ink/stage/<id>`，并带 `sandbox="allow-scripts allow-same-origin"`：画板运行自己的渲染器、读自己的数据流，别无所需——没有弹窗、没有顶层导航、没有表单提交。侧栏面向线上 Forage 部署而非本仓库提供的任何东西，因为 charter 让舞台独立于它的宿主。侧栏是一个观看者，它不复制画板渲染的任何部分。

## 绑定存在哪里，以及为何不是会话元数据

步骤要求绑定存在 DSH 会话元数据里，而那条路径确实存在且便宜：本包 node 半边注册一个 settings 命名空间（`ui-settings-general`/`ui-theme` 的写法，约二十行），浏览器半边经 `ctx.settingsScope` 写入。否掉它的理由是功能性的，而不是工作量。

`SettingsScopeBinder.bind` 用 `connection.isLoopback ? 'host' : 'memory'` 构造它的 controller，而在 `'memory'` 模式下 `SettingsScopeController.enqueue` 对每一次写入立即 resolve、根本不上线路。`isLoopback` 由 `window.location.hostname` 计算。这个特性所服务的部署是通过 Tailscale 与 LAN authority 访问的（`dsh web --trusted-host …`），所以 settings 支撑的绑定会恰好在正在使用的那条访问路径上悄悄不持久化，却还报告成功——这比干脆不声称持久化更糟。`localStorage` 记录在任何 authority 上都能持久化。

代价记录在包 README 里：绑定不会随操作者去另一个浏览器或设备，宿主也读不到它。当这两点中任一项成为需求时，升级路径是一个 Remote 服务背后的按 Session storage-domain sidecar，即 `message-feedback` 已经交付的形状。

## Alternatives considered

**`sidebar`、`conversation` 或 `details` 里的座位。** 每一个都是 `kind: 'single'` 且已被占用，而第二个条目是遮蔽而非并列：注册进去会删掉导航列、整个对话界面或详情列，并把那个占位者声明的每一个座位一并带走。`shell.overlay` 是加性座位，也是那个免费携带不受滚动影响性质的座位。

**对话列内部的座位（输入区 dock 或消息列表区域）。** 这是「聊天旁边的一块面板」最直觉的落点，也正是步骤所指的失败：滚动容器内的任何东西都会滚，而滚动父级内的 sticky 规则在父级回流时仍会移动。按需求否掉，而非按工作量。

**为绑定建一个宿主侧 Remote 服务。** `message-feedback` 的写法——`defineDomain`/`domainTable` 置于 `TypertRemoteService` 之后——是规范的持久化按 Session sidecar，会把绑定放到宿主读得到的磁盘上。它的代价是一个新宿主包、typert 代码生成，以及对 `packages/api/remotes/src/client/index.ts` 里硬编码 mount 列表的一次编辑。它买不到 settings 命名空间买不到的任何东西，而 settings 命名空间被否掉的理由跟用哪种持久化存储毫无关系。保留为已记录的升级路径。

**由 DSH 代理或转发舞台页。** 被 charter 否掉：舞台从不依赖它的宿主，而代理会让宿主成为画板传输的参与方。侧栏持有的是一个 URL。

**在内嵌之前对 Forage 校验会话 id。** 这能抓住已删除或打错的会话，但它让侧栏的行为成为 `forage.ink` 可达性的函数——正是独立性规则要防的那种耦合。操作者看到的是舞台 URL 返回的东西，对一个坏 id 而言就是 Forage 自己的答复。

**用会话选择器取代数字输入框。** 选择器需要一个 Forage 列表端点和一套选择模型，而它会成为本包里唯一不薄的部分。输入框加「绑定」就是绑定所需的全部交互。

## Consequences

不受滚动影响这一需求是结构性的而非样式性的，因此它无法因一次 CSS 编辑而退化：那需要把注册移到另一个 slot，而插件测试会抓住这一点。ui-layout、ui-sidebar 与 ui-conversation 都未改动，所以既有布局在本特性上承担零风险。

侧栏是浏览器本地状态，意味着它对宿主、对其他设备、对模型都不可见。这三重都是刻意的：模型通往画板的路径是它本来就会调用的 Forage 写入端点，因此侧栏完全没有面向模型的影响；而第二个浏览器打开同一会话只会看到一块关闭的侧栏，而不是一块错的。

本包 node 半边是惰性的，因此插件纯粹由它的 Loader 行激活。规范行位于 `packages/bundle/web-app/cordis.patch.yml`，那是只在启动时读取的层；要在**运行中**的宿主里激活该行，走的是 `$DSH_HOME` 补丁文件，`watchUserPatches` 监视它并事务性地重新组合。两条路径不得同时携带该行——`insert` 是无条件追加，所以同一个 id 会在条目列表里出现两次。

## Testing

`tests/browser-plugin.client.spec.ts` 在一个真实 `SlotRegistry` 之上启动浏览器半边，断言浮层座位、头部座位、fiber 拆除会移除两者（HMR 安全）、两个条目拿到同一个 store，以及在任一 face 上调用的动词能从另一个观察到。`tests/store.client.spec.ts` 覆盖 controller 的按会话独立性、每一个被拒值的归一化，以及一个新 controller rehydrate 出已持久化的侧栏——即重载这一情形。两个组件 spec 直接喂 props，断言渲染出的 iframe `src` 与 `sandbox`、未绑定状态，以及两个控件。`tests/styles.client.spec.ts` 对着主题样式表断言每一个 `--dsw-*` 名字（未声明的 token 会静默丢掉它所在的整条声明，同族的一张样式表就这样交付过），并断言面板脱离文档流定位。

按文件覆盖率在语句、分支、函数、行四项上均为 100%，无任何 `v8 ignore`。
