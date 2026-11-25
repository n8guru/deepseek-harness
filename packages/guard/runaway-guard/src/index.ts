/** Preset-scoped runaway policy for top-level agents. @module @deepseek-ai/dsh-runaway-guard */
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
  maxTokens?: number
  maxRepeatCalls?: number
  jobSettleTimeoutMs?: number
  /** Session-id regular expressions this preset must never stop (e.g. a standing interactive conductor). */
  exemptSessions?: string[]
}

export const Config: z<Config> = z.object({
  maxSteps: z.number().default(200),
  maxTokens: z.number().default(20_000_000),
  maxRepeatCalls: z.number().default(20),
  jobSettleTimeoutMs: z.number().default(30_000),
  exemptSessions: z.array(z.string()).default([]),
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

/** Install one guard in the current agent-preset scope. */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = limit(config.jobSettleTimeoutMs, 'jobSettleTimeoutMs')
  if (timeoutMs === undefined) throw new Error('runaway-guard: jobSettleTimeoutMs cannot be zero')
  // ponytail: id patterns because a session's preset cannot change after creation; a dedicated
  // unguarded conductor preset replaces this once the conductor is created with one.
  const exempt = (config.exemptSessions ?? []).map(pattern => new RegExp(pattern))
  installRunawayGuard(ctx, {
    maxSteps: limit(config.maxSteps, 'maxSteps'),
    maxTokens: limit(config.maxTokens, 'maxTokens'),
    maxRepeatCalls: limit(config.maxRepeatCalls, 'maxRepeatCalls'),
  }, {
    eventType: 'agent/runaway-stop',
    onStop: async agent => stopOwnedJobs(ctx, agent, timeoutMs),
    shouldGuard: agent => (agent.session.header.delegationDepth ?? 0) === 0
      && agent.session.header.origin !== 'subagent'
      && !exempt.some(pattern => pattern.test(String(agent.id))),
  })
}

export default { name, inject, Config, apply }
