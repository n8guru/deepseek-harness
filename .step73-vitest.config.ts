import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from './vitest.shared.ts'
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin(), {
    name: 'read-only-rc2-dependencies',
    resolveId(id, importer) {
      if (!importer || id.startsWith('.') || id.startsWith('/') || (id.startsWith('@deepseek-ai/') && !id.startsWith('@deepseek-ai/node-addon-')) || id.startsWith('node:')) return
      try { return createRequire(importer.replace('/home/n8/forage-worktrees/dsh-spoken-partition/', '/tmp/dsh-137481-worktree/')).resolve(id) }
      catch { return }
    },
  }],
  resolve: { alias: { zod: '/home/n8/forage-worktrees/dsh-spoken-partition/node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js' } },
  test: { include: ['packages/core/agent-loop/tests/**/*.spec.ts', 'packages/client/connection/tests/**/*.host.spec.ts', 'packages/goal/goal-round-driver/tests/**/*.spec.ts', 'packages/client/ui-conversation/tests/*focus*.client.spec.tsx', 'packages/schedule/schedule/tests/**/*.spec.ts', 'packages/jobs/tool-jobs/tests/**/*.spec.ts', 'packages/subagent/subagent/tests/**/*.spec.ts'], pool: 'forks' },
})
