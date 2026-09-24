// Web e2e scenario for mesh-dsh-merge step 52 (always-visible to-dos and
// inline decision cards): boots the REAL shipped Web composition (built
// dist, real chromium, real HTTP/SSE wire) with zero model calls, seeds one
// session whose assistant turn emits a fenced ```decision-card block plus a
// `todo/write` event, and drives the actual rendered DOM: the pinned Cadence
// todo strip appears expanded by default with status rows, the decision card
// renders exactly one highlighted recommendation, and clicking an option
// sends a normal tagged user message that locks the card on durable replay
// (page reload re-renders from the persisted log, not client memory).
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/todo-decision-cards', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/todo-decision-cards/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'todo-decision-cards-web-e2e'

const CARD_ID = 'ship-gate'
const CARD_JSON = JSON.stringify({
  id: CARD_ID,
  question: 'Ship the pinned to-dos and decision cards now?',
  options: [
    { label: 'Approve', recommended: true },
    { label: 'Discuss' },
  ],
})
const REPLY_TEXT = [
  'Both lists are pinned and visible below.',
  '',
  '```decision-card',
  CARD_JSON,
  '```',
].join('\n')

/** Build one settled assistant turn carrying a fenced decision-card and a todo/write event. */
function seedFixture(): string {
  const session = Session.create(SessionId('todo-decision-cards-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Show the pinned to-dos and a ship decision card.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Pinned to-dos and decision card',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('todo/write', {
    todos: [
      { content: 'Draft DESIGN.md', status: 'completed' },
      { content: 'Independent cross-provider review', status: 'in_progress' },
      { content: 'Nate preview acceptance', status: 'pending' },
    ],
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: REPLY_TEXT }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
    }),
    ...session.events.map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: pinned to-dos and inline decision cards', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, seedFixture(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('renders the pinned Cadence todo strip and an inline decision card, then locks it on a tagged reply', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-todo-decision-cards'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    // Pinned Cadence todo strip: default-open, status rows visible without a click.
    const panel = page.locator('[data-testid="todo-panel"]')
    await panel.waitFor({ timeout: 15_000 })
    await expect.poll(() => panel.locator('li').count(), { timeout: 10_000 }).toBe(3)
    const statuses = await panel.locator('li').evaluateAll(
      nodes => nodes.map(node => node.getAttribute('data-status')),
    )
    expect(statuses).toEqual(['completed', 'in_progress', 'pending'])

    // Inline decision card: exactly one highlighted recommendation, malformed
    // fence never leaks as raw text.
    await expect.poll(() => page.getByText('Ship the pinned to-dos and decision cards now?').count(), { timeout: 15_000 }).toBe(1)
    const recommended = page.getByRole('button', { name: /Approve/ })
    await recommended.waitFor({ timeout: 10_000 })
    expect(await recommended.getAttribute('data-recommended')).toBe('true')
    const discuss = page.getByRole('button', { name: 'Discuss' })
    expect(await discuss.getAttribute('data-recommended')).not.toBe('true')

    // Clicking sends a normal tagged user message through the composer path
    // (not an authenticated Studio operator approval) and the card locks.
    await recommended.click()
    await expect.poll(() => page.getByText(`[decision-card ${CARD_ID}] Approve`).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => recommended.getAttribute('data-chosen'), { timeout: 10_000 }).toBe('true')
    expect(await recommended.isDisabled()).toBe(true)

    // Durable replay: reload re-renders the lock from persisted history, not
    // client-side click state. The URL already addresses this session, so no
    // re-navigation through the sidebar tree is needed.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(() => page.getByText(`[decision-card ${CARD_ID}] Approve`).count(), { timeout: 15_000 }).toBe(1)
    const reloadedRecommended = page.getByRole('button', { name: /Approve/ })
    await expect.poll(() => reloadedRecommended.getAttribute('data-chosen'), { timeout: 10_000 }).toBe('true')
    expect(await reloadedRecommended.isDisabled()).toBe(true)

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 90_000)
})
