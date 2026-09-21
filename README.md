# jev

[![CI](https://github.com/imsukhe/jev/actions/workflows/ci.yml/badge.svg)](https://github.com/imsukhe/jev/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

**A wrapper that gets more value out of TypeSafe's JEV model.**

`jev` compacts a coding agent's transcript by asking JEV which tool calls still matter and deleting the rest — what survives is byte-for-byte, never summarized. It also picks how hard an agent should work on a task, and records what every call cost.

**A wrapper, not a replacement.** JEV does the scoring; `jev` decides what to ask, what to send, how to batch it under a token budget, and what to do with the answer. Independent project — not built, reviewed, or endorsed by TypeSafe AI or Vercel. You bring your own key.

## Install

Not on npm yet. Install from the repo:

```bash
git clone https://github.com/imsukhe/jev.git
cd jev && npm install && npm link
```

That gives you a `jev` command. (Once published it will be `npm install -g jev-ai` — package `jev-ai`, command `jev`, because `jev` on npm is an unrelated empty placeholder from 2022.)

## First run

```bash
cd /path/to/your-project
jev init --mode full --no-memory   # config only, nothing else touched
jev status
```

`jev init` and `jev mode` normally also **create or edit `CLAUDE.md` and `AGENTS.md`** in the project, adding a block between `<!-- jev:start -->` and `<!-- jev:end -->` so a session picks the mode up on its own. That is the point of the feature, but it edits files you own, so the example above opts out with `--no-memory`. Drop the flag once you want delivery; see [Modes](#modes-and-how-one-reaches-the-agent) for exactly what it writes and how to undo it.

Everything so far is local and free. Nothing has contacted JEV: that needs a key and an explicit opt-in, below.

## What it does

| | |
| --- | --- |
| **Compaction** | Asks JEV which tool calls and results still matter, then prunes the rest. Needs a key. Off by default. |
| **Auto mode** | `jev classify "<task>"` asks JEV how much effort a task deserves. Needs a key. |
| **Modes** | `off`, `lite`, `full`, `ultra`, delivered through `CLAUDE.md` / `AGENTS.md`. Local. |
| **Ledger** | Append-only record of token and cost usage, including `jev`'s own JEV calls. Local. |
| **Audit** | A `jev-audit` skill that reads the ledger and names where the waste is. Local. |

Use a mode from either host once a skill is installed (see [Install in a host](#install-in-a-host)):

```text
Codex:  $jev full
Claude: /jev:jev full
```

## Modes, and how one reaches the agent

`off`, `lite`, `full`, `ultra` — how hard the agent should work and how much it should spend getting there.

`.jev/config.json` is never read by a session, so writing a mode there alone would deliver it to nobody. `jev mode <name>` also writes a small managed block into `CLAUDE.md` and `AGENTS.md`, the files both hosts load themselves, so the mode is in context from the first turn:

```markdown
<!-- jev:start -->
## jev mode: full
Use targeted context, bounded tool output, focused verification, and no speculative delegation.
...
<!-- jev:end -->
```

Everything outside those markers is yours and is never touched: text above and below survives, switching modes replaces the block in place instead of appending another, re-running the same mode rewrites nothing at all, and a half-written marker makes `jev` refuse rather than guess. `jev mode off` removes the block and leaves the file as it was. Opt out with `--no-memory` or by emptying `memoryFiles`.

This is delivery, not enforcement — the agent follows the block as it follows any instruction. `off` is the one mode enforced in code, but enforced *in the CLI only*: `jev compact`, `jev compaction on`, and `jev classify` all refuse while it is set. It does **not** stop the Claude Code hook, which has its own `enabled` switch and cannot read `.jev/config.json` at all. To stop every JEV call in a project you have to turn both off — `jev mode off` for the CLI, and the plugin's `enabled` option (or removing its API key) for the hook.

## Auto mode

This calls JEV, so it needs a credential and **sends your task prompt over the network**. One small call per classification (~300 tokens), billed to your key and recorded in the ledger.

```bash
export AI_GATEWAY_API_KEY=...                  # or TYPESAFE_API_KEY for the direct backend
jev compaction on --backend vercel-gateway     # picks which backend classify uses too

jev classify "our checkout API 500s in production, find and fix it"
# mode: full (confidence 1.00)

jev classify "fix the typo 'recieve' in README.md" --apply
# mode: ultra (confidence 1.00) — applied
```

`--apply` persists the mode, which also writes the memory block unless you pass `--no-memory`. Backend and model come from the compaction settings; `jev classify` itself does not require compaction to be *enabled*, only configured.

Routing is what JEV is for, and it is good at it: on twelve hand-labelled prompts it agreed twelve times, in one 1.2s request.

The interesting part is where it fails. Given `"tiny fix: change the auth check from === to == in login.ts"` it answered `ultra` — a security-relevant change waved through as trivial. But it answered at **0.60 confidence**, where every correct answer in the same run scored 0.93 or better. So the rule is asymmetric: **a downgrade needs confidence, staying careful doesn't.** Below `minConfidence` (0.85) the answer falls back to `full` and says so:

```text
mode: full (suggested ultra at 0.64, below the 0.85 floor, so kept full)
```

With that guard, the adversarial set — casually-phrased data loss, alarming-sounding typos — goes 10/10.

## Compaction

Off until you turn it on, because it sends conversation content — tool call inputs and result text — to JEV.

```bash
jev compaction on --backend typesafe        # TYPESAFE_API_KEY (TypeSafe console invite required)
jev compaction on --backend vercel-gateway  # AI_GATEWAY_API_KEY (create at vercel.com, no linked project)
                                            #   or VERCEL_OIDC_TOKEN (`vercel link` / `vercel env pull`)
jev compact examples/transcript.json --json
```

Vercel AI Gateway needs a card on file before it serves anything, even under a free-credit promotion; `AI Gateway requires a valid credit card on file` is that, not a bug.

What the wrapper adds over a raw JEV call:

- Pairs every `tool_use` with its `tool_result`, and pins the first and newest messages so recent context is never touched.
- Fits the conversation into `maxStateTokens` by staged reduction, so a long session still fits one request's state.
- Splits questions across requests under `maxRequestTokens`, at most `maxConcurrentRequests` at once, refusing a fan-out past `maxRequests` (24, roughly 340 tool calls) — every request repeats the whole state, so the request count is the cost multiplier, and the refusal states the token total proceeding would cost.
- Caps the derived goal at `maxGoalChars`, and shrinks it further if the state still will not fit. A log pasted into a recent prompt would otherwise be the one part of the state no fitting stage could reduce.
- Shows JEV a bounded `resultExcerptChars` excerpt of each result, so it judges output it has actually seen.
- Applies `keepThreshold`: keep, truncate the result to `truncateHeadChars`, or drop the call with its result — never "truncating" a result into something longer than it started, and never dropping a call whose whole footprint is under `minDropChars`.
- Bounds each request with `requestTimeoutMs`, so a stall fails instead of hanging.
- Records JEV's own token usage to the ledger under `host: jev` — from the CLI only. The Claude Code hook cannot: its sandbox has no filesystem, so automatic compactions do not appear in `jev report`. Their cost shows up on your JEV bill and in the hook's own session log, not in the ledger.

`jev mode off` is the CLI kill switch: it force-disables compaction, and `jev compact`, `jev compaction on`, and `jev classify` all refuse while it's set. It has no reach into the hook — see above.

Claude Code can run compaction automatically: `hooks/compact.mjs` registers `session.compact` and replaces the built-in lossy summary with JEV-pruned history, falling back to that summary on any error or insufficient reduction. Verified on Claude Code 2.1.278 — `claude plugin validate` passes and the loader reports `hooks module jev@inline loaded (worker, environment 1); events: session.compact,turn.complete`. The hook has its **own** `enabled` switch (Claude Code's `/config`, off by default) and cannot read `.jev/config.json`, because the hook sandbox has no filesystem. See [Claude adapter notes](adapters/claude/README.md).

## CLI

```bash
jev init --mode full [--force] [--no-memory]
jev mode <off|lite|full|ultra> [--no-memory]
jev classify "<prompt>" [--apply] [--json]
jev compaction <on|off> [--backend typesafe|vercel-gateway] [--model name]
jev compact <transcript.json> [--json]
jev status [--json]
jev record --host claude --model claude-sonnet --input 1200 --output 250 --cost 0.018
jev report [--json]
```

`record` takes measured values from a host integration; it never invents a dollar estimate the host didn't report. `init` refuses to overwrite an existing config — pass `--force`, or use `jev mode` to change modes in place.

## Install in a host

### Claude Code

As a plugin, from this repo as a marketplace:

```bash
claude plugin marketplace add imsukhe/jev
claude plugin install jev@jev
```

Or load a clone directly without installing:

```bash
claude --plugin-dir /path/to/jev
```

Either way you get `/jev:jev` and `/jev:jev-audit`. Both commands above are verified against Claude Code 2.1.278.

The automatic compaction hook stays off until you turn on its own switch and give it a key:

```bash
claude plugin install jev@jev --config enabled=true   # or /plugin configure jev@jev in-session
export TYPESAFE_API_KEY=...                           # or set apiKey in the plugin config
```

That switch is the hook's alone — `jev mode off` in a terminal does not reach it. See [Claude adapter notes](adapters/claude/README.md).

Skills only, no plugin:

```bash
cp -r skills/jev skills/jev-audit /path/to/your-project/.claude/skills/
```

They become `/jev` and `/jev-audit`.

### Codex

Codex reads skills from a plugin's `skills/` directory or from `.agents/skills/`:

```bash
cp -r skills/jev skills/jev-audit /path/to/your-project/.agents/skills/
```

Invoke as `$jev` or `$jev-audit`. The automatic hook is Claude-Code-only; `jev compact` still works from the CLI. See [Codex adapter notes](adapters/codex/README.md).

## Architecture

```text
Codex skill ─┐
             ├─ shared policy ─ jev CLI ─ .jev/config.json
Claude skill ┘                     │      .jev/usage.jsonl
                                   ├─ compaction engine ─┐
                                   └─ classifier ────────┴─ TypeSafe JEV
                                                            (direct, or via Vercel AI Gateway)
```

`lib/compaction.mjs` and `lib/classify.mjs` are the engines, and neither imports a client or any `node:` module — that is what lets the Claude Code hook load the compaction engine inside a sandbox with no filesystem and no `process`, using its own asker over `$.http.fetch`. `lib/backends.mjs` picks a client for the Node-side entry points (`compactMessages.mjs`, `classifyPrompt.mjs`), and `lib/jevClient.mjs` / `lib/jevGatewayClient.mjs` are the two routes to the model.

Read [architecture](docs/architecture.md) and [integration research](docs/integration-research.md) for the details and the design sources.

## Development

```bash
npm test && npm run lint && npm run validate
npm run fidelity   # test 0: needs a key, makes live calls
```

Tests use fakes and local HTTP stubs; nothing in the suite calls a real API. `npm run fidelity` is the exception and is deliberately not in CI: it measures whether compaction preserves answers, which requires the real model. `ai` and `@ai-sdk/gateway` are needed only for the `vercel-gateway` backend.

## Security and privacy

- Do not commit `.jev/` files.
- `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`, and `VERCEL_OIDC_TOKEN` belong in your environment or a secret manager — never in `.jev/config.json`, a plugin manifest, or any repository file.
- Compaction is off by default. Enabled, it sends tool call inputs and result text to JEV; `jev classify` sends the prompt. Nothing else here makes a network call.

## Prior art

Design ideas, not code, from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), the locally installed Caveman skill, [Claude Code Usage Dashboard](https://github.com/AgenticSec/ClaudeCodeUsageDashboard), [Claude Context Optimizer](https://github.com/LEON-gittech/claude-context-optimizer), [CodeLedger](https://github.com/bhvbhushan/codeledger), and [Codex Token Saver](https://github.com/wyzg952/codex-token-saver). See [integration research](docs/integration-research.md).

## License

[MIT](LICENSE)
