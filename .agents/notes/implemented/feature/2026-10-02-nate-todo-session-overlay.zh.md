# Agent Note: Nate 待办页的会话内 overlay

Status: implemented

[English](2026-10-02-nate-todo-session-overlay.md) | 中文

## 问题

Nate 的常驻队列已有循环回环 HTML 页 `http://127.0.0.1:3091/`，可展示内联说明并提交答案。在另一个浏览器标签打开该页会离开 DSH 会话。[web todo 展示](2026-07-23-web-todo-display.md) 的 dock 列出开放行、文件打开说明链接与内联 decision card；它并不托管该 HTML 页。

## 决策

钉住的 `conversation.input.dock` todo 条（`todoDockEntry`，order 0）拥有持久的「打开」控件，挂载 `NateTodoOverlay`：一个文档内 `Modal`，其主体是 `http://127.0.0.1:3091/` 的 iframe。该 overlay 叠在当前 DSH Web 会话之上；从不调用 `window.open`，也从不把对话导航走。

Nate 行保留文件打开说明按钮。overlay 是单独的入口，既不替换那些链接，也不是第二套 decision-card 渲染。iframe 使用 `referrerPolicy="no-referrer"`；overlay 不在 DOM、URL 或消息载荷中携带 Studio token。

当托管页报告剩余开放项为零时，它显示 “All answered — closing”，并向父窗口 `postMessage` `{type:'nate-todo-all-answered'}`。`isNateTodoDoneMessage` 仅接受来自该循环回环页 origin 的载荷，随后 overlay 自行关闭。`window.close()` 仍作为脚本打开的 popup 回退。

循环回环服务器允许来自另一个循环回环 `http` Origin（DSH iframe）的 GET，并将 POST `/answer` 保持同源，因此外来循环回环页无法 CSRF 提交答案。其 CSP `frame-ancestors` 列出循环回环 DSH Web origin。

## 考虑过的替代方案

- **`window.open` popup** — Nate 要求叠在当前会话上的弹出层，而不是另一个浏览器标签；浏览器也会在无用户手势时拦截 `window.open`，并在普通标签上忽略 `window.close`。
- **在 TodoPanel 内复制 HTML 表单** — 会分叉实时队列页及其 POST `/answer` 路径；托管既有页面只保留一个来源。
- **把对话导航到 3091** — 离开 DSH 会话，而这正是本 overlay 要避免的缺陷。
- **用 fenced decision card 承接该队列** — 那些卡片发送带标签的聊天消息；本页写入 `tools/nate-todo.json` 且 `answered_via=nate-todo-form`。混用会模糊两条作答路径。

## 后果

dock 的「打开」控件是持久的会话内来源。窄屏 CSS 把 overlay 做成全视口 sheet。覆盖：`packages/client/ui-conversation/tests/nate-todo-dock.client.spec.tsx` 以及 `todo-panel.client.spec.tsx` 中的 TodoDock overlay 用例；循环回环页的 `--self-check`。已构建 DSH GUI 证明与生产刷新仍只在合并排空重启窗口进行。
