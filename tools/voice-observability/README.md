# Staged voice observability 1.4.8-step73-observability.1

SOURCE/STAGING ONLY. Do not copy into installed local-mods or activate/reload from this unit.

client.js is the exact supplied served voice1.4.8 snapshot (also equal to installed read-only source SHA256 1cb79c4ce7b1f20b802555c5fb466c16aafd5815153ea5d3741b324e5c0237bd), plus only version/observability changes. No voice, endpoints, speaker preference, ownership, dictation, lease or synthesis/playback changes. No espeak fallback.

playSpoken emits correlated block_skipped with speaker-disabled or not-speech-owner, once for newly consumed text; it does not enqueue speech. Queue creation/enqueue exception emits bounded block_failed/queue-unavailable; failure is not a statement that every part was unheard. Existing rememberSpoken dedupe remains, including deliberate suppression on later tab changes. reportTtsStatus dispatches local dsh-voice-status CustomEvent and attempts the existing bridge POST. Local observation and best-effort POST do not prove backend receipt, playback or hearing.

index.js is the READ-ONLY installed native voice Host plugin snapshot with only new event vocabulary/description support. It is NOT a qualified rc2 Host plugin: historical register-route and message-source APIs remain inherited; do not mount until actual release-specific migration/boot qualification. No parallel receiver or guessed native API was introduced. The current browser reporter posts to the external configured voice bridge, not this Host route; that bridge's acceptance/query retention for the two new event kinds is an external handoff, NOT tested here. No bridge files edited or new live requests sent.

Run:
node --check tools/voice-observability/client.js
node --check tools/voice-observability/index.js
node --test tools/voice-observability/observability.test.mjs

Five targeted function-level tests passed. These test the actual staged playSpoken/reporter/description code with keyless surface/queue stubs, NOT a browser, full native profile or live configured-voice roundtrip.

## Separate Forage embed owner handoff

Provided outer workspace HTML /tmp/cadence-workspace-live.html:13:
iframe#forage-workspace-page allow="microphone; clipboard-read; clipboard-write"

Provided inner slidein /tmp/cadence-dsh-slidein-live.js:103:
frame.allow = "microphone; clipboard-read; clipboard-write"

Both omit autoplay. Owner should qualify delegation across BOTH origins/layers and actual browser autoplay/user activation, speaker flag, authoritative active-client routing, configured bridge and truthful statuses. Do not assert this alone fixes the silence. No Forage edits or browser access by this writer.

## Accepted-human mode evidence

The three supplied read-only artifacts contain no accepted prompt request records showing whether the two cadence human replies were queue or steer. Their actual mode remains UNKNOWN. Native actual-caller test separately proves both contracts; never infer original mode from visible acceptance.
