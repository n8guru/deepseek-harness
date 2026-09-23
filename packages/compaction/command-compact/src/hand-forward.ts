/**
 * Opt-in self-compaction scheduling. Audit files are not session replay state.
 * @module @deepseek-ai/dsh-command-compact/hand-forward
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-fs'
import { createHash } from 'node:crypto'
import { openAudit } from './baton-audit.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Deployment-owned paths; tool callers cannot select the audit destination. */
export interface HandForwardConfig {
  /** Host-local audit root, independent of session persistence. */
  auditDirectory?: string
  /** Default readable baton in the agent's filesystem world. */
  batonPath?: string
  /** Maximum baton bytes read and hashed; default one MiB. */
  maxBatonBytes?: number
  /** Abandoned-pending recovery age; never expires a live owner's kernel lock. Default 120 seconds, minimum five seconds. */
  staleMs?: number
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function route(agent: Agent): { provider: string; model: string } {
  const config = agent.session.requestHeader()?.config ?? agent.options
  if (!config.provider || !config.model) throw new Error('hand_forward requires an exact active provider and model')
  return { provider: config.provider, model: config.model }
}

/**
 * Register the generic-rendered scheduling tool; never await idle inside its execution.
 * @param ctx - agent/tool and compaction services.
 * @param config - deployment-owned audit and default baton paths.
 */
export function installHandForward(ctx: Context, config: HandForwardConfig): void {
  const staleMs = config.staleMs ?? 120000
  if (!Number.isFinite(staleMs) || staleMs < 5000) throw new Error('handForward.staleMs must be at least 5000')
  const pending = new Set<string>()
  const active = new Set<Promise<void>>()
  const shutdown = new AbortController()
  const auditRoot = config.auditDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'hand-forward')
  const defaultBaton = config.batonPath ?? '/home/n8/forge-agent-os/tools/CONDUCTOR-BATON.md'

  ctx.effect(function* () {
    yield async () => {
      shutdown.abort(new Error('hand_forward plugin disposed'))
      await Promise.allSettled(active)
    }
    yield ctx.tools.register(defineTool({
      name: 'hand_forward',
      description: 'Schedule self-compaction at whole-agent idle, then one baton bootstrap turn. Returns immediately after validation and audit; never compacts a running turn. Context percentage is estimated request pressure for the exact active model, not cumulative billing.',
      parameters: {
        reason: { type: 'string', required: true, description: 'Why this is a good point to pass the baton.' },
        baton_path: { type: 'string', description: 'Readable nonempty baton file; defaults to the conductor baton.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            scheduled: { type: 'boolean', required: true },
            generation: { type: 'integer', required: true },
            at_context_pct: { type: 'number', required: true },
            context_tokens: { type: 'number', required: true },
            context_capacity: { type: 'number', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('hand_forward requires a live agent')
        if (!args.reason.trim()) throw new Error('reason must not be empty')
        if (pending.has(agent.id)) throw new Error('hand_forward already pending')
        pending.add(agent.id)
        let audit: Awaited<ReturnType<typeof openAudit>> | undefined
        const fenceAbort = new AbortController()
        const operationSignal = AbortSignal.any([shutdown.signal, fenceAbort.signal])
        let handedOff = false
        try {
          const baton = args.baton_path ?? defaultBaton
          if (!baton.trim() || /[\r\n]/u.test(baton)) throw new Error('invalid baton path')
          const target = await ctx.fs.resolve(baton, agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd })
          const info = await ctx.fs.stat(target, exec.signal)
          if (!info || info.type !== 'file') throw new Error('baton file is missing or not regular')
          const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxBatonBytes ?? 1024 * 1024)
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          if (!text.trim()) throw new Error('baton file is empty')
          const selected = route(agent)
          const capacity = (await ctx.llm.resolveModelInfo(selected.provider, selected.model, exec.signal)).context?.contextWindow
          if (!capacity || !Number.isFinite(capacity) || capacity <= 0) throw new Error('exact model context capacity unavailable')
          if (JSON.stringify(route(agent)) !== JSON.stringify(selected)) throw new Error('model changed during measurement; retry')
          const measurement = ctx.tokenMeter.measure(agent.session)
          exec.signal.throwIfAborted()
          operationSignal.throwIfAborted()
          const directory = join(auditRoot, digest(agent.id))
          const journal = await openAudit(directory, staleMs, (error) => { fenceAbort.abort(error) })
          audit = journal
          const generation = journal.generation
          const record = {
            generation, session_id: agent.id, time: new Date().toISOString(), ...selected,
            baton_path: target.displayPath, baton_sha256: digest(bytes), reason: args.reason,
            at_context_pct: measurement.totalTokens / capacity * 100,
          }
          await journal.record({ ...record, status: 'scheduled' }, true)
          // Work begins on the next microtask and waits for the driver AND maintenance.
          // The tool result must settle so its owning turn can itself finish.
          const work = (async () => {
            try {
              await new Promise<void>((resolve, reject) => {
                const abort = (): void => { reject(new Error('hand_forward scheduling cancelled')) }
                operationSignal.addEventListener('abort', abort, { once: true })
                const cleanup = (): void => { operationSignal.removeEventListener('abort', abort) }
                void agent.whenIdle().then(() => { cleanup(); resolve() }, (error: unknown) => {
                  cleanup()
                  reject(error instanceof Error ? error : new Error(String(error)))
                })
                if (operationSignal.aborted) abort()
              })
              operationSignal.throwIfAborted()
              if (ctx.agents.get(agent.id) !== agent) throw new Error('agent is no longer live')
              // Persisted fence reads happen under the kernel reservation, held across both effects.
              journal.assertOwner()
              await ctx.compaction.compactNow(agent, operationSignal)
              journal.assertOwner()
              operationSignal.throwIfAborted()
              agent.followup(createUserMessage({
                content: [{ type: 'text', text: `Baton generation start. Read ${target.displayPath} and Studio slug=conductor-relay, then give Nate one short state update.` }],
                source: { kind: 'plugin', plugin: 'hand-forward' },
              }))
              await ctx.sessions.flush(agent.session)
              await journal.record({ ...record, time: new Date().toISOString(), status: 'bootstrap-queued' }, false)
            } catch (error) {
              await journal.record({ ...record, time: new Date().toISOString(), status: 'failed', error: String(error) }, false)
            } finally {
              pending.delete(agent.id)
              await journal.release()
            }
          })()
          active.add(work)
          void work.then(() => active.delete(work), (error: unknown) => {
            active.delete(work)
            ctx.logger.error('hand_forward audit/cleanup failed: %s', error)
          })
          handedOff = true
          return {
            scheduled: true, generation, at_context_pct: record.at_context_pct,
            context_tokens: measurement.totalTokens, context_capacity: capacity, ...selected,
          }
        } finally {
          if (!handedOff) {
            pending.delete(agent.id)
            if (audit) await audit.release()
          }
        }
      },
    }))
  }, 'hand-forward lifecycle')
}
