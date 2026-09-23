# Agent Note: Shared spoken text and inline highlighting

Status: revised after review 3; not activated

## Shared authority

The conductor changed acceptance after review 3: the shared parser, not the legacy regex, is authoritative. ui-primitives owns recognition and `spokenTextParts`, the source-to-displayed-text mapping used by both voice speechText and React highlights. Both consumers depend downward on ui-primitives. Recognized source ranges remain half-open UTF-16 offsets; logs remain unchanged.

Only bare complete prose pairs supply markers. Code, escaped/entity markers, bracket forms (including bracket-wrapped angle-tag tokens and pairs), quoted adjacent wrappers, definitions and destinations are excluded. Unclosed pairs stay literal. Quotes elsewhere never pair across prose or URLs. The Markdown document remains whole; references and formatting cross speech boundaries normally.

## Intended differences: legacy bugs

- Three backticks in a link URL do not start a fence: speech after that link remains audible.
- Backticks inside link destinations/titles are data, not code. Speech uses displayed link labels, not URLs or titles.
- Escaped backticks in prose remain literal audible backticks, not stripped code.
- Formatting syntax is not spoken: emphasis, decoded entities and reference links contribute displayed prose.
- Bracket-wrapped tags are literal; the legacy regex incorrectly treated them as speech.

Speech and highlight share text/HTML leaf slicing and a single settled GFM+math grammar even while streaming. Code, images, math and footnote definitions have no highlighted text or speech. Structural block/code boundaries become whitespace in spoken strings. Ordinary non-spoken documents retain incremental rendering.

## HTML and safety

Raw HTML leaves remain React text, never HTML elements. They now pass through the same range mapper: `<div><spoken>yes</spoken></div>` displays literal div markers with only yes highlighted and spoken. Existing URL allowlisting is unchanged. Inline tint still uses existing theme tokens.

## Proof and delivery

One invariant test loops the shared acceptance corpus in streaming and settled modes, compares explicit expected speech, then compares the set of actual DOM-highlight strings grouped by speech region with the set of speech strings. The corpus includes legacy bugs, bracket wrappers, HTML-ish blocks, Markdown formatting/references, code, quotes, streaming partials and multiple regions. Actual live/staged voice clients additionally document intended old/new differences.

The out-of-tree runtime candidate still delegates to the parser; its bytes and live runtime remain unchanged. Build ui-primitives, ui-conversation and the web shell together. Fresh review, actual-browser theme/audio checks and coordinated deployment remain required. Old-shell tabs must drain/reload before staged voice activation. No activation, restart or push is authorized here.
