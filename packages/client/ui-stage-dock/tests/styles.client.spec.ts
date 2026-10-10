/**
 * Stage-dock stylesheet contract, asserted against the CSS text on disk.
 *
 * An undeclared `--dsw-*` name has no fallback and does not inherit: the whole
 * declaration is thrown away, so the control renders as if the line had never
 * been written, and nothing downstream reports it. The sibling feedback sheet
 * shipped with no border and no surface exactly this way.
 *
 * The scroll-independence claim is also asserted here: the panel is positioned
 * out of flow in the overlay layer, so no column's scroll container can move
 * it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/StageDock.module.css', import.meta.url)),
  'utf8',
)
// The theme package maps `./styles/*` to `./src/styles/*`, so the declarations
// stay on the source plane rather than needing a build. Every theme sheet, not
// just the platform tokens: font and scrollbar variables are declared in
// siblings, and a gate reading one file would call their names undeclared.
const tokens = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

/**
 * The declarations of one top-level rule, by selector.
 * @param selector - the class selector to read, including its leading dot.
 * @returns the rule's declaration text.
 */
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`StageDock.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('StageDock theme styles', () => {
  it('names only theme variables the token sheets define', () => {
    const named = [...css.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
    // Vacuity guard: the sheet has to actually name tokens, or the filter below
    // is satisfied by an empty list and this test proves nothing.
    expect(named.length).toBeGreaterThan(5)
    const undeclared = [...new Set(named)].filter(name => !tokens.includes(`--${String(name).slice(2)}:`))
    expect(undeclared).toEqual([])
  })

  it('never falls back to a literal colour', () => {
    expect(css).not.toMatch(/var\(--dsw-[a-z0-9-]+\s*,\s*(?:#|rgb|rgba|hsl|hsla)/)
  })

  it('pins the panel out of flow, so transcript scrolling cannot move it', () => {
    expect(block('.panel')).toMatch(/position:\s*absolute/)
    expect(block('.panel')).toMatch(/right:\s*0/)
  })

  it('closes every block, so no rule is swallowed by the one above it', () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
  })
})
