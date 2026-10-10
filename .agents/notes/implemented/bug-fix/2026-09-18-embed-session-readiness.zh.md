# Agent Note: 嵌入式会话列表就绪

Status: implemented

[English](2026-09-18-embed-session-readiness.md) | 中文

## Problem

已有会话的紧凑视图在 UI 挂载前初始化，但客户端插件激活并不等待 Host 会话列表。在此期间选择已有 pump 会话，会将 Host 实际列出的会话误报为未知会话。

## Decision

[嵌入视图初始化器](../../../../apps/web/src/embed.ts) 在选择已有会话前等待会话服务共享的 `refresh()`。带页面上下文的 page-curator 创建行为保持不变。Host 列表获取失败及真正未知的会话仍会报错；此路由绝不创建替代会话。

## Alternatives considered

**用计时器延迟。** Host 延迟不固定；经过一段时间并不能证明列表已就绪。

**用给定标识符创建或恢复。** 创建操作可能改变所有权或启动其他会话，而不是观察指定会话。

## Consequences

已有会话的嵌入视图等待权威列表，并复用正在进行的请求。启动耗时可能与该请求一样长。测试覆盖延迟成功以及刷新失败时不选择、不创建会话。此改动需要重新构建 Web 外壳，不需要重启 Host。
