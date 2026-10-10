# Agent Note: Subagent 侧边栏分组

Status: implemented

[English](2026-09-22-subagent-sidebar-group.md) | 中文

## Problem

所选父会话的 subagent 目录支持导航，但全局侧边栏隐藏委派会话，操作员无法集中看到运行中的子会话，也无法直接归档已结束的子会话行。

## Decision

Workspace 浏览器根据 `origin: 'subagent'` 的持久化会话摘要派生虚拟 **Sub-agents** 分组。存在真实 **Forge Agent OS** Workspace 时，它紧随其后；否则位于真实 Workspace 之后、**Ungrouped** 之前。该分组保留真实 Workspace 的顺序和成员关系；它不是注册表 Workspace，也没有创建、重命名、删除或重排操作。标题报告运行中的子会话数。已结束的子会话持续可见，直到显式的归档会话操作写入现有的全局归档集合。运行中的子会话不显示该菜单操作；不按时间自动清理。归档后的日志和 Workspace 成员关系保留。

父会话的描述符目录仍是续接模式和人工跟进的权威来源。侧边栏摘要仅授予导航，不授予独立续接权限。[Web subagent 目录决策](2026-07-27-web-subagent-conversations.md)仍拥有生命周期和传输规则；本决策仅替换其侧边栏隐藏的展示选择。

## Alternatives considered

**真实 Host Workspace。** Workspace 需要目录并拥有成员顺序。委派会话有自己的 cwd，也可能已归属于项目 Workspace；移动它们会改变无关项目的分组。

**按时间自动清理。** 时间不能证明子会话已经结束，而且会剥夺 conductor 对归档时机的决定权。显式归档将该决定留给操作员。

**第二套归档存储。** 注册表已有持久化的全局归档集合及 `workspace.archiveSession`；平行存储会产生冲突的可见性规则。

## Consequences

侧边栏提供集中活动计数和已结束子会话的直接归档控制，同时不改变会话日志或 Host Workspace 顺序。现有归档机制会在各展示界面隐藏已归档行，浏览器没有取消归档视图；恢复不属于本次侧边栏改动。
