# Agent Note: Authenticated native session Focus

Status: proposed

English | [中文](2026-10-02-native-session-focus.zh.md)

## Problem

Human input and uncredentialed notification RPCs share source:user authority. Holding by report text or client labels would hold human quotations while missing actual producers. Routine worker deliveries interrupt foreground testing; ambiguous acknowledgements replay cumulative reports.

## Proposal

The isolated source candidate authenticates a dedicated Connection admission operation using explicit operator-owned producer hash/target/urgency grants; empty grants fail closed. Native producers supply owned identities. Existing Inbox/log owns Focus, origin+sequence receipts and bounded Check snapshots. Human/coordinator/unknown inputs bypass. No daemon, separate mailbox, credentials provisioning or scheduler authority is introduced. [Connection](../../../../packages/client/connection/README.md#authenticated-notification-admission-and-operator-focus) owns the ABI.

## Alternatives considered

Host/Origin checks are reachability, not authentication. Caller-supplied notification labels are spoofable. A plugin-only notice filter misses the real ordinary session.prompt broker. Task-id dedup loses distinct results; text dedup misclassifies human quotes.

## Acceptance criteria

Independent review must establish durable admission/reload, exact retry identities, held eligibility, human/Stop races, urgency grants and operator controls through source and assembled examples. Activation additionally requires separately authorized provisioning, broker integration, qualified artifacts and the external atomic idle fence. No source-ready, live or Nate-test-pass claim follows from implementer tests.

## Risks

Bearer secrecy and truthful critical classification remain operator/producer responsibilities. Model-entry dedup does not guarantee exactly-once external side effects after a crash. Persistent receipt history grows with the session. Source-only authorization does not provision any producer; live ingress stays unavailable until explicitly configured. Old builds reject the required Focus event instead of silently running held work.
