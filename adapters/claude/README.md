# Claude Code adapter

Claude Code plugins namespace skills. With the root `.claude-plugin/plugin.json` installed as `jev`, use:

```text
/jev:jev full
/jev:jev-audit
```

For a project-only setup, copy `skills/jev` and `skills/jev-audit` into `.claude/skills/`. They become `/jev` and `/jev-audit`.

## Automatic compaction hook (opt-in)

This hook uses TypeSafe's JEV model to score and prune stale tool calls/results. It's an independent client of TypeSafe's public API, not affiliated with TypeSafe AI or Vercel — see [README](../../README.md).

`hooks/compact.mjs` registers `session.compact` and `turn.complete`. **It has its own `enabled` userConfig switch, default false, and does not read this project's `.jev/config.json`** — the hook sandbox has no filesystem access, so `jev compaction on/off` and `jev mode` run in a terminal cannot reach it. Installing the plugin does not enable it; turn it on with the plugin's own `enabled` setting (Claude Code's `/config`) and an `apiKey` or `TYPESAFE_API_KEY`.

- **Trigger**: `session.compact` (a compaction is about to happen — manual `/compact` or automatic); `turn.complete` requests one once `context.percent` reaches `compactAtPercent` (default 60). Both are a no-op, with no HTTP call attempted, while `enabled` is false.
- **Input schema**: `event.messages`, a `SessionMessage[]` transcript — see `lib/compaction.mjs`'s `Message`/`ToolUse`/`ToolResult` JSDoc types.
- **Execution cost**: one or more HTTP requests to TypeSafe's JEV model per compaction (batched to stay under `maxRequestTokens`, default one to a handful depending on transcript size). `maxRequests` (default 24, roughly 340 tool calls) refuses a larger fan-out rather than spending on it; the refusal names the token total proceeding would cost, and `maxRequests` is a `userConfig` option so that advice is actionable from here.
- **Not in the ledger**: these compactions do *not* appear in `jev report`. The hook sandbox has no filesystem, so it cannot append to `.jev/usage.jsonl` the way `jev compact` and `jev classify` do. Their cost lands on your JEV bill and in the hook's own session log only.
- **Output cap**: `maxStateTokens` (default 25000) bounds what is sent; `truncateHeadChars` (default 300) bounds what a dropped tool result keeps.
- **Privacy behavior**: sends tool call inputs and tool result text — real conversation content — to TypeSafe (or, with the `vercel-gateway` backend via the CLI only, Vercel AI Gateway). This is the only network call this repository makes. See [compaction](../../README.md#compaction).
- **Opt-out**: set the plugin's `enabled` option to false (its default), or never set an API key. Any failure (missing key, JEV error, malformed response, state too large, reduction below `minReductionRatio`) falls back to Claude Code's built-in compaction — the hook never throws out of a session.
- **Fixture tests**: `test/hooksCompact.test.mjs` exercises the hook's success/fallback logic against a fake engine; `test/compaction.test.mjs` and `test/jevClient.test.mjs` cover the underlying engine and HTTP client. None make a real network call.
- **Verified**: against Claude Code 2.1.278 (as of the `$`-call surface and the hook module; the `maxRequests`, `maxConcurrentRequests`, `maxGoalChars` and `requestTimeoutMs` `userConfig` entries added later have not been re-run through it), `claude plugin validate` passes and resolves every `$` call, and loading with `--plugin-dir` logs `hooks module jev@inline loaded (worker, environment 1); events: session.compact,turn.complete` with `turn.complete` settling in 0.8ms on its disabled path. What is still unverified is a live `session.compact` carrying a real transcript, which needs an authenticated session long enough to compact plus an API key. The function-hook surface is early access and may change between releases.

`jev compact <transcript.json>` is the manual, host-independent equivalent and supports both backends; use it to test compaction without a live session.

See [Claude Code's feature overview](https://code.claude.com/docs/en/features-overview) for the distinction between skills, hooks, plugins, and MCP.
