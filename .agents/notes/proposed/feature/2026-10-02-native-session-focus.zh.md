# Agent Note: 经认证的原生会话 Focus

Status: proposed

[English](2026-10-02-native-session-focus.md) | 中文

## Problem

人类输入与未持凭据的通知 RPC 共用 source:user 权限。按报告文本或客户端标签暂存会误扣人类引用，同时漏掉真实生产方。常规 worker 交付打断前台测试；结果不明的应答导致累计报告重放。

## Proposal

隔离源码候选通过显式、由操作方拥有的生产方 hash／目标／紧急授权，认证专用 Connection 准入操作；空授权拒绝准入。原生生产方提供其拥有的标识。现有 Inbox/log 拥有 Focus、origin+sequence 回执及有界 Check 快照。人类／协调方／未知输入不受限制。不引入 daemon、独立 mailbox、凭据配置或调度权限。[Connection](../../../../packages/client/connection/README.md#authenticated-notification-admission-and-operator-focus)规定 ABI。

## Alternatives considered

Host/Origin 检查控制可达性，而非认证。调用方提供的通知标签可伪造。仅插件通知过滤会漏掉实际使用普通 session.prompt 的 broker。按任务标识去重会丢失不同结果；按文本去重会误判人类引用。

## Acceptance criteria

独立审查必须通过源码与组装示例确认持久准入／重载、精确重试标识、暂存资格、人类／Stop 竞态、紧急授权及操作方控制。激活还要求另行授权的凭据配置、broker 集成、合格构建产物及外部原子空闲栅栏。实现方测试不构成源码就绪、上线或 Nate 测试通过声明。

## Risks

Bearer 保密及真实关键分类仍由操作方／生产方负责。模型入口去重不保证崩溃后外部副作用恰好一次。持久回执历史随会话增长。仅源码授权不配置任何生产方；显式配置前实时入口不可用。旧构建拒绝必需 Focus 事件，而不静默执行暂存工作。
