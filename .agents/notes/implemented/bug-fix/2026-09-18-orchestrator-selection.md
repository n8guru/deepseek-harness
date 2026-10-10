# Agent Note: Orchestrator selection persistence

Status: implemented

English | [中文](2026-09-18-orchestrator-selection.zh.md)

## Problem

The native picker stores its last selection globally in the DSH origin. Inspecting a worker in another frame changes that restoration target, but must not change the Forage orchestrator's chosen session after a reload.

## Decision

The [selection bridge](../../../../apps/web/src/orchestrator-bridge.ts) observes the native session list only when an embedded window explicitly opts into an allowlisted Forage parent origin. It posts a selected, Host-listed session identifier to that exact parent origin; catalog-only child selections invalidate the candidate because they require a parent address. The parent owns its separate pin, validates the sending frame and origin, and requires an explicit confirmation before resuming the identifier through the existing-session embed route. A restored global worker is only a candidate, not an implicit replacement for the existing pin. The application context owns subscription disposal.

The same allowlisted iframe opt-in marks only the root route as a chooser before the shell mounts. Its native sidebar starts expanded even at 640px or 390px; normal roots retain narrow auto-collapse and `/embed` remains conversation-only. Native workspace browsing and `workspaces.startSession()` own selection and creation; no new Host API, parent action listener, synthetic click, automatic selection or prompt is added.

### Selection receipt

Every subscription emits an initial `dsh-orchestrator-session` receipt, including no selection, and emits again when any exposed field changes. Fields are `sessionId: string | null`, `phase: 'pending' | 'ready'`, optional `displayTitle: string`, and optional `reason: 'no-selection' | 'unsupported-session'`. Every receipt also carries `attempt: string | null`, captured from `orchestrator_attempt` when the bridge subscribes. A safe identifier starts with an ASCII letter or digit and contains at most 128 letters, digits, underscores or hyphens; absent or invalid identifiers echo null for older parents. The parent compares the exact current attempt in addition to origin and iframe source, because retries preserve the iframe WindowProxy and can receive queued older receipts. Every receipt confirms that the bridge is live. Pending catalogs publish null candidates without a reason; ready unselected views publish `no-selection`; invalid identifiers and catalog-only children publish `unsupported-session`. Only a ready, eligible selection publishes its identifier and a nonempty title when available, without a reason. Titles have controls and bidi formatting removed, whitespace collapsed, and a 160-Unicode-code-point bound; parents must render them as text, never HTML. The target origin is always exact, and the parent must also validate event origin and iframe source.

## Alternatives considered

**Read DSH storage from Forage.** Cross-origin access is prohibited, and the global value does not identify the orchestrator.

**Create a dedicated session implicitly.** That changes the user's choice and can create unwanted sessions. The native picker remains responsible for selection and creation.

## Consequences

The receipt contains only selection metadata, never transcript text, credentials, page context, or prompt authority. Normal top-level DSH and untrusted parent origins receive no receipt. Browser storage denial limits restoration to the mounted frame. An expanded sidebar uses at most the iframe width, even in a 195px half-screen phone drawer. Below the preferred 280px sidebar width the conversation stays mounted at zero width; expanding the frame restores the preferred width, and the native toggle can reveal the conversation. Normal layout minimums and column solving remain unchanged. New Session may reuse a blank workspace session. Chooser workspace-row actions stay visible without hover, so the explicit **New session in {workspace}** action works without a current or recent workspace. The global action without a target opens the native unselected view, whose center is hidden in a 195px chooser; use the explicit row action instead. If no workspace is registered, use native Add workspace or Full DSH; confirmation stays disabled until a real selection exists. Focused tests cover origin gating, initial/readiness/title changes, child rejection, teardown, and narrow layout isolation. The staged assembled browser check remains required before delivery. No agent transcript or model input changes.
