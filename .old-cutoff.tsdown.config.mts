import { defineConfig } from 'tsdown'
// Diagnostic scoped equivalent of old workspace Host index bundling, not a shipped config.
export default defineConfig({
  entry: [process.cwd() + '/lib/types/index.js'], outDir: process.cwd() + '/lib', format: ['esm'],
  platform: 'node', target: 'es2024', fixedExtension: false,
  dts: false, clean: false,
})
