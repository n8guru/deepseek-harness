// Shared acceptance corpus: expected displayed speech, not legacy regex output.
export const spokenFixtures: readonly (readonly [string, readonly string[], string])[] = [
  ['[<spoken>one\ntwo</spoken>]', [], 'multiline bracket wrapper'],
  ['[<spoken>one\r\ntwo</spoken>]', [], 'CRLF bracket wrapper'],
  ['<spoken>| a | b |\n|---|---|\n| c | d | hidden |\n</spoken>', ['a b c d'], 'overflow table cells omitted'],
  ['<spoken>| a | b |\n|---|---|\n| c |\n</spoken>', ['a b c'], 'short table rows padded silently'],
  ['<spoken>one</spoken> <spoken>two</spoken> <spoken>one</spoken>', ['one', 'two', 'one'], 'ordered repeated regions'],

  [
    '[a](https://example.com/```) <spoken>yes</spoken>',
    [
      'yes',
    ],
    'legacy bug: URL backticks are not a fence',
  ],
  [
    '<spoken>[a](https://example.com/`x`) yes</spoken>',
    [
      'a yes',
    ],
    'legacy bug: destination backticks are URL data; speak label',
  ],
  [
    '<spoken>[a](https://example.com "`title`") yes</spoken>',
    [
      'a yes',
    ],
    'legacy bug: title backticks are data; speak label',
  ],
  [
    '<spoken>Hello \\`not code\\` world</spoken>',
    [
      'Hello `not code` world',
    ],
    'legacy bug: escaped backticks are prose',
  ],
  [
    '[<spoken>x</spoken>]',
    [],
    'bracket-wrapped pair',
  ],
  [
    '[<spoken>]yes[</spoken>]',
    [],
    'bracket-wrapped markers',
  ],
  [
    '<div><spoken>yes</spoken></div>',
    [
      'yes',
    ],
    'inert HTML highlights',
  ],
  [
    '<div>\n<spoken>yes</spoken>\n</div>',
    [
      'yes',
    ],
    'multiline inert HTML',
  ],
  [
    '<spoken>**bold** [link][r]</spoken>\n\n[r]: https://example.com',
    [
      'bold link',
    ],
    'displayed prose instead of Markdown syntax',
  ],
  [
    '<spoken>he**llo** &amp; bye</spoken>',
    [
      'hello & bye',
    ],
    'adjacent formatting and entities',
  ],
  [
    '<spoken>one\n\n- two\n- three</spoken>',
    [
      'one two three',
    ],
    'block boundaries',
  ],
  [
    'before <spoken>one</spoken> middle <spoken>two</spoken> after',
    [
      'one',
      'two',
    ],
    'separate regions',
  ],
  [
    '<spoken>one `code` two</spoken>',
    [
      'one two',
    ],
    'code omitted',
  ],
  [
    '~~~\n<spoken>no</spoken>\n~~~',
    [],
    'tilde fence',
  ],
  [
    '    <spoken>no</spoken>',
    [],
    'indented code',
  ],
  [
    '``multi\n<spoken>no</spoken>``',
    [],
    'multiline code',
  ],
  [
    '"<spoken>no</spoken>"',
    [],
    'quoted pair',
  ],
  [
    '"<spoken>" mention <spoken>yes</spoken>',
    [
      'yes',
    ],
    'quoted token',
  ],
  [
    '\\<spoken>no\\</spoken>',
    [],
    'escaped markers',
  ],
  [
    '&lt;spoken&gt;no&lt;/spoken&gt;',
    [],
    'entity markers',
  ],
  [
    '[spoken]no[/spoken]',
    [],
    'bracket mentions',
  ],
  [
    '<spoken>unfinished',
    [],
    'incomplete pair',
  ],
  [
    '<spoken>$x$ math</spoken>',
    [
      'math',
    ],
    'math excluded from speech/highlights',
  ],
  [
    '[a](https://example.com/") <spoken>yes</spoken> [b](https://example.com/")',
    [
      'yes',
    ],
    'URL quote regression',
  ],
  [
    '<spoken><img src=x onerror=alert(1)>safe</spoken>',
    [
      '<img src=x onerror=alert(1)>safe',
    ],
    'inert HTML safe text',
  ],
  [
    '[<spoken>[a](https://example.com)</spoken>]',
    [],
    'nested bracket wrapper',
  ],
  [
    '<spoken>hello[^n]\n\n[^n]: note\n\n</spoken>',
    [
      'hello',
    ],
    'definition text is not speech',
  ],
  [
    '<spoken>| a | b |\n|---|---|\n| c | d |</spoken>',
    [
      'a b c d',
    ],
    'table boundaries',
  ],
  [
    '<spoken>before\n\n> quoted prose\n\nafter</spoken>',
    [
      'before quoted prose after',
    ],
    'outer speech across blockquote',
  ],
]
