# Task 158363: graphify gate location

The authorized target is the DeepSeek Harness repository. An isolated worktree was created from `560ed16d93822c99412997981664f6d344f68d15` on `agents/forge/task-158363-resume`.

The requested gate is not present in this checkout: searching tracked source and docs for `graphify first`, `load_mcp`, `filesearch`, `worker hook`, and `grounding gate` found no graphify-before-filesearch gate. The repository's hook packages implement Claude Code/Codex hook bridges, not this MCP availability check. Graphify query of the Forage index also did not identify a DSH-owned gate. No implementation or tests were added because selecting a different gate or weakening an unrelated hook would be unsafe.

Required continuation: identify the exact DSH-owned source file or configured local plugin that emits `graphify first - load_mcp({ server: "graphify" })`; then implement availability-aware fallback and a recorded note at that owner, add tests for available/unavailable cases, run focused tests, and publish the resulting branch+commit for conductor landing. No DSH runtime build, deployment, or restart was performed.
