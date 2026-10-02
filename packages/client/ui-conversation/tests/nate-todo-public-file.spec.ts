import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface NateTodoRow {
  id?: string
  question?: string
  explained_at?: string
  status?: string
}

const here = dirname(fileURLToPath(import.meta.url))
const publicFile = resolve(here, '../../../../apps/web/public/local/nate-todo.json')

describe('apps/web/public/local/nate-todo.json', () => {
  it('parses and yields the open canonical rows', () => {
    const data = JSON.parse(readFileSync(publicFile, 'utf8')) as { items?: NateTodoRow[] }
    const items = Array.isArray(data.items) ? data.items : []
    const open = items.filter(row => row.status === 'open' && row.question && row.explained_at)
    expect(open.length).toBeGreaterThan(0)
    for (const row of open) {
      expect(typeof row.id).toBe('string')
      expect(row.explained_at).toMatch(/\S/)
    }
  })
})
