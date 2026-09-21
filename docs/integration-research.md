# Integration research

Research completed 2026-09-21. This project borrows architecture ideas only. It does not copy source code, data, branding, or claims from these projects.

| Reference | Pattern adopted | Decision here |
| --- | --- | --- |
| Caveman | Session-persistent mode levels and concise operating instructions. | Provide `off`, `lite`, `full`, and `ultra`, while keeping safety language and verification intact. |
| [Claude Code Usage Dashboard](https://github.com/AgenticSec/ClaudeCodeUsageDashboard) | Session-end collection with per-model token, cache, skill, MCP, and subagent attribution. | Define a local append-only ledger now; add host collectors only after schema and privacy tests. |
| [Claude Context Optimizer](https://github.com/LEON-gittech/claude-context-optimizer) | Audit context files, plugins, hooks, and MCP servers as recurring overhead. | Include an audit skill that examines repeated context and duplicate work before recommending changes. |
| [CodeLedger](https://github.com/bhvbhushan/codeledger) | Multi-tool, per-project and per-agent cost attribution. | Keep the ledger host-neutral from day one. |
| [Codex Token Saver](https://github.com/wyzg952/codex-token-saver) | Route by task risk and verification need; do not force cheap model use for complex work. | Make escalation evidence-based and never assume host model availability. |
| [OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins) | Start with skills when instructions and existing tools are enough; add MCP or UI later. | Ship skills plus CLI first. |
| [Claude Code feature model](https://code.claude.com/docs/en/features-overview) | Use skills for on-demand workflows and hooks for deterministic host actions. | Keep mode switching in skills; reserve hooks for future, tested collectors. |
| [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) | Score every tool call/result with TypeSafe's JEV model, keep verbatim or drop rather than lossily summarize; fall back to the host's built-in compaction on any error or insufficient reduction. | Reimplement the algorithm fresh in `lib/compaction.mjs` (own code, following the same design), support both TypeSafe-direct and Vercel AI Gateway as backends, wire it into `jev compact` and an opt-in `hooks/compact.mjs`. Off by default; documented as the one thing in this repo that sends conversation content over the network. |

## Design constraints

1. Skills improve behavior but do not enforce billing.
2. Hooks can create hidden overhead. Every future hook must publish its trigger, execution cost, output cap, and opt-out path.
3. Provider usage formats change. Each collector needs fixture tests from real redacted records.
4. Cost estimates differ from billed cost. Label estimates and prefer provider-reported usage.
