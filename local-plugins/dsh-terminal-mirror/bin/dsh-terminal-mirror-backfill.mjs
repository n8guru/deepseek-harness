#!/usr/bin/env node
/**
 * Backfill CLI: replay the forge-agent-os conductor session logs through the
 * live mirror's classifier and post the missing operator turns and final
 * replies to /v3/terminal-mirror.
 *
 * Safe by default: `--dry-run` posts nothing and touches no state file, and a
 * real run records every posted row in a durable state file so a re-run
 * inserts 0 duplicates.
 *
 *   node bin/dsh-terminal-mirror-backfill.mjs --dry-run
 *   node bin/dsh-terminal-mirror-backfill.mjs
 *   node bin/dsh-terminal-mirror-backfill.mjs --session cadence-gen-10
 */
import { parseArgs } from 'node:util'
import { backfill, defaultSessionRoot, defaultStatePath } from '../lib/backfill.js'
import { defaultAgentAuthor } from '../lib/index.js'
import { createPoster, DEFAULT_ENDPOINT } from '../lib/post.js'

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    state: { type: 'string' },
    session: { type: 'string', multiple: true },
    endpoint: { type: 'string' },
    agent: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stdout.write(`Usage: dsh-terminal-mirror-backfill [options]

  --root <dir>       DSH session root (default ${defaultSessionRoot()})
  --state <file>     idempotency state file (default ${defaultStatePath()})
  --session <id>     backfill only this session id (repeatable)
  --endpoint <url>   mirror endpoint (default ${DEFAULT_ENDPOINT})
  --agent <name>     author for agent replies (default ${defaultAgentAuthor()})
  --dry-run          report what would post; sends nothing, writes no state
`)
  process.exit(0)
}

const statePath = values.state ?? defaultStatePath()
const totals = await backfill({
  root: values.root ?? defaultSessionRoot(),
  statePath,
  only: values.session,
  dryRun: values['dry-run'],
  agentFrom: values.agent ?? defaultAgentAuthor(),
  post: createPoster({ endpoint: values.endpoint ?? DEFAULT_ENDPOINT }),
})

process.stdout.write(`${JSON.stringify({ statePath, ...totals }, null, 2)}\n`)
