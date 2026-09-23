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
  /** Maximum pre-compaction idle wait; default ten minutes. */
  idleTimeoutMs?: number
  /** Per-phase warning deadline, NOT a lock expiry; default five minutes. */
  watchdogMs?: number
  /** Maximum plugin teardown wait; unfinished effects retain their reservation. Default ten seconds. */
  disposeTimeoutMs?: number
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
  const idleTimeoutMs = config.idleTimeoutMs ?? 600000
  const watchdogMs = config.watchdogMs ?? 300000
  const disposeTimeoutMs = config.disposeTimeoutMs ?? 10000
  for (const [name, value] of Object.entries({ idleTimeoutMs, watchdogMs, disposeTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error(`handForward.${name} must be a positive timer duration`)
  }
  const active = new Map<Promise<void>, (message: string) => void>()
  const shutdown = new AbortController()
  const auditRoot = config.auditDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'hand-forward')
  const defaultBaton = config.batonPath ?? '/home/n8/forge-agent-os/tools/CONDUCTOR-BATON.md'

  ctx.effect(function* () {
    yield async () => {
      shutdown.abort(new Error('hand_forward plugin disposed'))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled(active.keys()),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              for (const notice of active.values()) notice('hand_forward disposal deadline exceeded: reservation retained; supervised host recovery required')
              resolve()
            }, disposeTimeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
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
          // Existing plugin-source transcript messages are visible without waking a turn.
          // No new session event, storage format, or replay semantics are introduced.
          const notice = (message: string): void => {
            ctx.logger.error('%s (session=%s generation=%s)', message, agent.id, generation)
            try {
              journal.assertOwner()
              agent.session.append('user/message', createUserMessage({
                content: [{ type: 'text', text: message }],
                source: { kind: 'plugin', plugin: 'hand-forward' },
              }), { surfaceOp: 'append' })
            } catch (error) {
              ctx.logger.error('hand_forward notice delivery failed: %s', error)
            }
          }
          let watchdog: ReturnType<typeof setTimeout> | undefined
          const watch = (phase: string): void => {
            clearTimeout(watchdog)
            watchdog = setTimeout(() => {
              const message = `hand_forward watchdog: ${phase} exceeded ${watchdogMs}ms; reservation retained; supervised host recovery required`
              notice(message)
              void journal.record({ ...record, time: new Date().toISOString(), status: 'watchdog', phase, reason: message }, true)
                .catch((error: unknown) => { ctx.logger.error('hand_forward watchdog audit failed: %s', error) })
            }, watchdogMs)
          }
          const idleExpired = new Error('hand_forward abandoned: session never idle')
          const idleDeadline = Date.now() + idleTimeoutMs
          const work = (async () => {
            try {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { cleanup(); reject(idleExpired) }, idleTimeoutMs)
                const cleanup = (): void => {
                  clearTimeout(timer)
                  operationSignal.removeEventListener('abort', abort)
                }
                const abort = (): void => { cleanup(); reject(new Error('hand_forward scheduling cancelled')) }
                operationSignal.addEventListener('abort', abort, { once: true })
                void agent.whenIdle().then(() => { cleanup(); resolve() }, (error: unknown) => {
                  cleanup()
                  reject(error instanceof Error ? error : new Error(String(error)))
                })
                if (operationSignal.aborted) abort()
              })
              operationSignal.throwIfAborted()
              if (Date.now() >= idleDeadline) throw idleExpired
              if (ctx.agents.get(agent.id) !== agent) throw new Error('agent is no longer live')
              // Persisted fence reads happen under the kernel reservation, held across both effects.
              journal.assertOwner()
              watch('compaction')
              await ctx.compaction.compactNow(agent, operationSignal)
              journal.assertOwner()
              operationSignal.throwIfAborted()
              watch('bootstrap')
              agent.followup(createUserMessage({
                content: [{ type: 'text', text: `Baton generation start. Read ${target.displayPath} and Studio slug=conductor-relay, then give Nate one short state update.` }],
                source: { kind: 'plugin', plugin: 'hand-forward' },
              }))
              await ctx.sessions.flush(agent.session)
              await journal.record({ ...record, time: new Date().toISOString(), status: 'bootstrap-queued' }, true)
              // Include the bootstrap turn (and any coalesced work), not just enqueue/flush.
              await agent.whenIdle()
              clearTimeout(watchdog)
              await journal.record({ ...record, time: new Date().toISOString(), status: 'completed' }, false)
            } catch (error) {
              clearTimeout(watchdog)
              if (error === idleExpired) notice(idleExpired.message)
              await journal.record({ ...record, time: new Date().toISOString(), status: error === idleExpired ? 'abandoned' : 'failed', error: String(error) }, false)
            } finally {
              clearTimeout(watchdog)
              pending.delete(agent.id)
              await journal.release()
            }
          })()
          active.set(work, notice)
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
