// Standalone config: the repository root config only includes packages/*,
// apps/*, examples/* and scripts/* suites, so this local plugin runs its own.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.spec.mjs'] },
})
