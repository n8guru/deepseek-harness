/** Preset-scoped runaway policy for top-level agents. @module @deepseek-ai/dsh-runaway-guard */
import { readFileSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { installRunawayGuard } from '@deepseek-ai/dsh-subagent'

export const name = 'runaway-guard'
export const inject = ['jobs']

/** Configured limits; zero disables one limit. */
export interface Config {
  maxSteps?: number
  /** Budget on UNCACHED work (input + output + cache writes); cache reads are reported, never counted. */
  maxTokens?: number
  maxRepeatCalls?: number
  /** Burst check: uncached tokens within any rolling hour. */
  maxTokensPerHour?: number
  /** Burst check: subagent/workflow/ralph delegation calls within any rolling hour. */
  maxDelegationsPerHour?: number
  jobSettleTimeoutMs?: number
  /**
   * Path of the conductor session registry's state file (dsh-session-registry
   * `state.json`). A session holding a conductor seat there (a key of its
   * `opened` map) is never stopped: the role marker is the registry seat, not
   * the session id, so a conductor named anything is still exempt.
   */
  conductorSeatRegistry?: string
}

export const Config: z<Config> = z.object({
  maxSteps: z.number().default(200),
  maxTokens: z.number().default(20_000_000),
  maxRepeatCalls: z.number().default(20),
  maxTokensPerHour: z.number().default(0),
  maxDelegationsPerHour: z.number().default(0),
  jobSettleTimeoutMs: z.number().default(30_000),
  conductorSeatRegistry: z.string().default(''),
})

function limit(value: number | undefined, field: string): number | undefined {
  if (value === 0) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`runaway-guard: ${field} must be zero or a positive safe integer`)
  }
  return value
}

async function stopOwnedJobs(ctx: Context, agent: Agent, timeoutMs: number): Promise<void> {
  const live = ctx.jobs.list(agent).filter(job => job.ownerSession === agent.id
    && (job.status === 'running' || job.status === 'stopping'))
  const issues: string[] = []
  await Promise.all(live.map(async (job: JobSnapshot) => {
    if (job.status === 'running') {
      try {
        ctx.jobs.kill(job.id, agent, 'owner stopped by runaway guard')
      } catch (error) {
        issues.push(`${job.id}: cancel failed: ${String(error)}`)
      }
    }
    try {
      const settled = await ctx.jobs.wait(job.id, timeoutMs, agent)
      if (settled.status === 'running' || settled.status === 'stopping') {
        issues.push(`${job.id}: did not settle within ${String(timeoutMs)}ms`)
      }
    } catch (error) {
      issues.push(`${job.id}: wait failed: ${String(error)}`)
    }
  }))
  if (issues.length > 0) {
    const detail = issues.join('; ')
    ctx.logger.warn(`runaway-guard: background-job cleanup incomplete: ${detail}`)
    throw new AggregateError(issues, `runaway-guard: background-job cleanup incomplete: ${detail}`)
  }
}

/**
 * Session ids holding a conductor seat in the registry file. Re-read only when
 * the file's mtime changes; a missing or malformed file seats nobody.
 */
export function conductorSeats(path: string): (id: string) => boolean {
  let mtime = -1
  let seats = new Set<string>()
  return (id) => {
    if (path === '') return false
    let current: number
    try {
      current = statSync(path).mtimeMs
    } catch {
      mtime = -1
      seats = new Set()
      return false
    }
    if (current !== mtime) {
      mtime = current
      try {
        const opened = (JSON.parse(readFileSync(path, 'utf8')) as { opened?: unknown }).opened
        seats = new Set(opened !== null && typeof opened === 'object' ? Object.keys(opened) : [])
      } catch {
        seats = new Set()
      }
    }
    return seats.has(id)
  }
}

/** Install one guard in the current agent-preset scope. */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = limit(config.jobSettleTimeoutMs, 'jobSettleTimeoutMs')
  if (timeoutMs === undefined) throw new Error('runaway-guard: jobSettleTimeoutMs cannot be zero')
  // A session's preset cannot change after creation, so the standing conductor (which shares this
  // preset) is exempted by its registry seat, checked every step so a hand-forward moves the exemption.
  const seated = conductorSeats(config.conductorSeatRegistry ?? '')
  installRunawayGuard(ctx, {
    maxSteps: limit(config.maxSteps, 'maxSteps'),
    maxTokens: limit(config.maxTokens, 'maxTokens'),
    maxRepeatCalls: limit(config.maxRepeatCalls, 'maxRepeatCalls'),
    maxTokensPerHour: limit(config.maxTokensPerHour ?? 0, 'maxTokensPerHour'),
    maxDelegationsPerHour: limit(config.maxDelegationsPerHour ?? 0, 'maxDelegationsPerHour'),
  }, {
    eventType: 'agent/runaway-stop',
    onStop: async agent => stopOwnedJobs(ctx, agent, timeoutMs),
    shouldGuard: agent => (agent.session.header.delegationDepth ?? 0) === 0
      && agent.session.header.origin !== 'subagent'
      && !seated(String(agent.id)),
  })
}

export default { name, inject, Config, apply }
