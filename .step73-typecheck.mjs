import ts from 'typescript'
import path from 'node:path'
const root = process.cwd()
const reference = '/tmp/dsh-137481-worktree'
const input = process.argv[2] ?? 'tsconfig.client.json'
const configPath = path.join(root, input)
const read = ts.readConfigFile(configPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath))
const options = { ...parsed.options, composite: false, incremental: false, noEmit: true }
delete options.rootDir
delete options.tsBuildInfoFile
const host = ts.createCompilerHost(options)
host.resolveModuleNames = (names, importer) => names.map(name => {
  const resolved = ts.resolveModuleName(name, importer, options, host).resolvedModule
  if (resolved) return resolved
  if (!name.startsWith('.') && !name.startsWith('/') && (!name.startsWith('@deepseek-ai/dsh-') || name.endsWith('/remote'))) {
    return ts.resolveModuleName(name, importer.replace(root, reference), { ...options, paths: undefined }, host).resolvedModule
  }
})
const program = ts.createProgram(parsed.fileNames, options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
process.stdout.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => root, getCanonicalFileName: x => x, getNewLine: () => '\n',
}))
console.log(input + ': ' + diagnostics.length + ' diagnostics (read-only rc2 dependency fallback)')
process.exitCode = diagnostics.length ? 1 : 0
