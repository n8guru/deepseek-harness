# Agent Note: Durable old-source maintenance without invented authentication

Status: proposed

English | [中文](2026-10-08-old-maintenance-receiver.zh.md)

## Problem

An in-memory cutoff cannot preserve closure across process replacement. A caller-supplied owner string or successful browser-trust check cannot establish authenticated maintenance authority. A disposal grace deadline also cannot prove a producer has joined.

## Proposal

Retain exact initial-admission capabilities and actual failed-publication/WorkerRun join evidence from the old-source candidate. The opt-in maintenance receiver records full revisions in the existing session persistence backend, rejects malformed transitions, snapshots queued commands and responses, retains retired owner/run identities, and joins in-flight writes on teardown. Close precedes persistence; uncertain durability leaves the live Host closed. Release never reopens the current process.

Both public subagent start paths snapshot inputs and reject an already-aborted signal before reserving admission. A synchronous initial-capability setup failure releases its reservation because provider ownership has not begun. After provider invocation, rejection alone still cannot retire unknown work; authenticated cleanup evidence remains required.

The source candidate deliberately has no HTTP binding until an authenticated transport principal is identified. The existing Connection Host/Origin fence explicitly excludes authentication. The receiver is not enabled in shipped bundles.

## Alternatives considered

Treating loopback, Host, Origin, a body owner, or a service-presence check as authentication would fabricate authority. Adding another credential store or server would create an unrequested security mechanism. A direct service-only proof remains useful for persistence and ownership behavior, provided it is not called authenticated or a live first-cutoff proof.

## Acceptance criteria

A completed receiver needs a real authenticated existing gateway caller and negative unauthenticated/principal-substitution tests. A completed boot fence needs an enforced ordering barrier before every producer can publish, not merely a receiver that holds admission after its own construction. Independent review remains required.

The isolated Loader scripts exercise rebuilt old artifacts with no paid provider: the finish script covers initial materialization and join accounting; the receiver script uses three fresh processes to test durable closure and release. Direct service calls do not satisfy transport acceptance.

## Risks

The constructor replay hold does not protect the interval before the receiver is constructed. Full host compilation also has unrelated markdown-project TS6307 errors; affected-package compilation and bundling are a narrower result. None of these artifacts closes an already loaded production Host, changes credentials, activates a release, or authorizes restarting it.
