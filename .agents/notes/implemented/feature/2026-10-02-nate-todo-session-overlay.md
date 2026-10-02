# Agent Note: In-session overlay for Nate's todo page

Status: implemented

English | [中文](2026-10-02-nate-todo-session-overlay.zh.md)

## Problem

Nate's standing queue already has a loopback HTML page at `http://127.0.0.1:3091/` that shows inline explanations and accepts answers. Opening that page in another browser tab leaves the DSH session. The [web todo display](2026-07-23-web-todo-display.md) dock lists open rows with file-open explanation links and inline decision cards; it does not host the HTML page.

## Decision

The pinned `conversation.input.dock` todo strip (`todoDockEntry`, order 0) owns a persistent Open control that mounts `NateTodoOverlay`: an in-document `Modal` whose body is an iframe of `http://127.0.0.1:3091/`. The overlay stays above the current DSH Web session; it never calls `window.open` and never navigates the conversation away.

Nate rows keep their file-open explanation buttons. The overlay is a separate affordance, not a replacement for those links and not a second decision-card renderer. The iframe uses `referrerPolicy="no-referrer"`; the overlay carries no Studio token in DOM, URL, or message payload.

When the hosted page reports zero remaining open items, it shows "All answered — closing" and `postMessage`s `{type:'nate-todo-all-answered'}` to the parent. `isNateTodoDoneMessage` accepts that payload only from the loopback page origin, then the overlay closes itself. `window.close()` remains as a fallback for a script-opened popup.

The loopback server allows GET from another loopback `http` Origin (the DSH iframe) and keeps POST `/answer` same-origin, so a foreign loopback page cannot CSRF an answer. Its CSP `frame-ancestors` lists loopback DSH Web origins.

## Alternatives considered

- **`window.open` popup** — Nate asked for a pop-up over the current session, not another browser tab; browsers also block `window.open` without a user gesture and ignore `window.close` on a normal tab.
- **Duplicate the HTML form inside TodoPanel** — would fork the live queue page and its POST `/answer` path; hosting the existing page keeps one source.
- **Navigate the conversation to 3091** — leaves the DSH session, which is the defect this overlay exists to avoid.
- **Reuse fenced decision cards for this queue** — those cards send tagged chat messages; this page writes `tools/nate-todo.json` with `answered_via=nate-todo-form`. Mixing them would blur two answer paths.

## Consequences

The dock Open control is the persistent in-session source. Phone-width CSS makes the overlay a full-viewport sheet. Coverage: `packages/client/ui-conversation/tests/nate-todo-dock.client.spec.tsx` and the TodoDock overlay case in `todo-panel.client.spec.tsx`; the loopback page's `--self-check`. Built DSH GUI proof and production refresh stay in the combined drained restart window.
