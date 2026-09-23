# Agent Note: Shared spoken parsing and assistant highlighting

Status: implemented, not activated

## Decision

The Cordis-free ui-primitives package owns `parseSpokenSegments`, shared through the existing shell-seeded module table. It already owns Markdown parsing and both conversation and voice depend downward on it, so no conversation-to-voice cycle or new plugin is needed. CommonMark code node offsets mask code without changing UTF-16 positions. HTML recognition is disabled during this code scan so a spoken block cannot conceal nested code fences.

Complete pairs are case-insensitive and preserve the legacy first-close and whitespace normalization behavior. Unclosed pairs remain literal. Tilde fences, indented code, multi-backtick and multiline code spans intentionally improve on the old regex. Speech omits code; display preserves it.

## Presentation and limitations

AssistantMarkdown renders each spoken region with normal Markdown and a theme-token background and left accent. Logged text and playback input remain untouched. Each region is a separate Markdown document; references and formatting cannot cross the region boundary, and inline spoken regions become blocks. Incomplete streaming tags remain visible until their closing tag arrives. Parsing is linear in the current text and does not use the incremental Markdown cache.

## Delivery

Build ui-primitives, ui-conversation and the web shell together. The out-of-tree dsh-voice candidate requires the new shell export. Its live source is symlinked into the web profile, so leave the old live client in place and stage the candidate until coordinated artifact activation. No server/RPC changes or restart are required by this source change; existing-server activation must be verified by the deploying owner.

## Evidence

Parser tests pin legacy parity, source coverage and CommonMark code exclusion. AssistantMarkdown tests pin Markdown rendering, literal code mentions, streaming closure and a DOM snapshot. The voice mention/playback tests accept the real emitted shared parser and the staged client through explicit environment paths. Full assembled browser replay and independent review remain delivery gates.
