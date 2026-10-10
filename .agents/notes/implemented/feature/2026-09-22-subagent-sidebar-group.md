# Agent Note: Subagent sidebar group

Status: implemented

English | [中文](2026-09-22-subagent-sidebar-group.zh.md)

## Problem

The selected parent's subagent catalog supports navigation, but hiding delegated sessions from the global sidebar prevents the operator from seeing all active child conversations together or archiving finished child rows directly.

## Decision

The Workspace browser derives a virtual **Sub-agents** section from durable session summaries with `origin: 'subagent'`. It appears immediately after the real **Forge Agent OS** Workspace when present, otherwise after real Workspaces and before **Ungrouped**. The section preserves real Workspace ordering and membership; it is not a registry Workspace and has no create, rename, delete, or reorder action. Its header reports the number of running child sessions. Finished child sessions remain visible until an explicit Archive session action writes the existing registry-global archive set. The sidebar withholds that menu action for a running child; no age-based cleanup is performed. The archived log and Workspace membership are retained.

The parent's descriptor-backed catalog remains authoritative for continuation mode and human follow-up. A sidebar summary grants navigation only, not independent continuation authority. The [Web subagent catalog decision](2026-07-27-web-subagent-conversations.md) still owns those lifecycle and transport rules; this decision replaces only its sidebar-omission presentation choice.

## Alternatives considered

**A real Host Workspace.** A Workspace requires a directory and owns membership order. Delegated sessions have their own cwd and may already be accounted to a project Workspace, so moving them would mutate unrelated project grouping.

**Automatic age cleanup.** Age does not prove a child finished and would take archive timing away from the conductor. Explicit archive leaves that decision with the operator.

**A second archive store.** The registry already has a durable global archive set and `workspace.archiveSession`; a parallel store would create conflicting visibility rules.

## Consequences

The sidebar gives the operator a single active-count summary and direct finished-child archive control without changing session logs or Host Workspace order. The existing archive mechanism hides archived rows across presentation surfaces and has no browser unarchive view; restoration remains outside this sidebar change.
