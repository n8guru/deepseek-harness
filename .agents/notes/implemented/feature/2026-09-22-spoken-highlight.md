# Agent Note: Shared spoken parsing and inline highlighting

Status: revised after failed independent review; not activated

## Decision

The Cordis-free ui-primitives package owns `parseSpokenSegments`, shared through the existing shell-seeded module table. Both conversation and voice depend downward on it, avoiding a conversation-to-voice cycle. CommonMark AST positions identify prose and mask code without changing original UTF-16 offsets. HTML recognition is disabled during recognition so spoken blocks cannot conceal code.

Only bare prose pairs speak. Complete pairs are case-insensitive; first-close matching and whitespace normalization retain bare-prose legacy behavior. Unclosed pairs stay literal. Any CommonMark code, paired straight/curly quoted mentions, Markdown blockquotes, escaped tags, HTML entity forms and bracket forms cannot supply markers. Definitions and link destinations are not prose. Quotation exclusion is local: matching straight/curly quotes must immediately surround one marker token or one complete inline pair. Quotes elsewhere in prose, URLs, titles, measurements or apostrophes never pair across a bare speech region. Re-review 2 found the previous document-wide quote scanner incorrectly suppressed speech between quoted URL characters; that scanner has been replaced and ten real-client parity fixtures cover the regression and neighboring cases. Speech inside recognized pairs omits code.

The operator explicitly approved code silence after independent review rejected a88aa66 for changing the old regex behavior. Tests now distinguish exact bare-prose parity from approved differences, and record both old and new outputs for tilde fences, indented code, multiline spans and quoted/escaped pairs. Valid Markdown differences are no longer described as malformed-input exceptions.

## Single-document rendering

AssistantMarkdown passes one raw text block to MarkdownText with `highlightSpoken`. The shared parser removes recognized markers and projects their content ranges into one Markdown source. One AST retains cross-boundary emphasis, link labels, external reference definitions, lists and footnotes. Only text leaves are split into inline spans at the mapped range boundaries; code stays unhighlighted. The existing React HTML escaping and URL allowlist remain unchanged.

The maintained micromark decoder maps source positions past character references and backslash escapes; line alignment accounts for list continuation indentation. The inline tint uses existing light/dark theme tokens. Completed spoken documents reparse fully while streaming because a closing tag can change earlier ranges. Ordinary documents keep incremental rendering; unclosed tags stay literal.

## Delivery and evidence

Build ui-primitives, ui-conversation and the web shell together. The staged out-of-tree voice candidate still delegates to the same parser; its runtime bytes need no change for this revision. Live voice remains untouched. Publishing the candidate alone is unsafe: verify the new shell export and quiesce/reload old-shell tabs before coordinated voice activation. No activation, restart or push is authorized here; restart-free shell publication is unproven.

Parser and component tests cover approved exclusions, bare parity, source ranges, inline continuity, cross-boundary formatting/links, externally defined references, entities, escapes, indentation, streaming and a DOM snapshot. A voice differential test loads both actual clients against the emitted parser. Fresh independent review and assembled light/dark browser checks remain delivery gates.
