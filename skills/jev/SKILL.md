---
name: jev
description: Set or inspect jev cost-control modes. Use when the user asks to save tokens, reduce agent cost, use jev mode, or run jev on/off/lite/full/ultra/status.
---

# jev mode

`jev` is a wrapper around TypeSafe's JEV model: it adds cost-control modes, a local usage ledger, and JEV-backed transcript compaction for coding agents. This skill covers the modes, which are local behavior only and make no JEV calls.

## Invocation

- Codex: `$jev <off|lite|full|ultra|status>`.
- Claude Code plugin: `/jev:jev <off|lite|full|ultra|status>`.
- CLI: `jev mode <off|lite|full|ultra>` or `jev status` from the target project.

## Mode behavior

`off`: Use host defaults. Record usage only. The CLI makes no JEV calls; the Claude Code hook has a separate switch and is not covered by this.

`lite`: Keep answers concise. Do not repeat context. Read named files before broad searches.

`full`: Use targeted searches, bounded command output, one focused verification path, and no subagent unless its expected benefit exceeds its context cost.

`ultra`: Start with a compact task brief. Read only evidence needed for the next decision. Prefer direct execution for small tasks. Escalate model, reasoning, testing, or delegation only when a concrete risk requires it.

## Rules in every enabled mode

1. Preserve requirements, tests, security checks, exact commands, paths, and irreversible-action warnings.
2. Do not claim a token or dollar saving without measured usage data.
3. Do not select a model unavailable in the current host.
4. Do not change model, spending, or host settings without explicit user instruction.
5. Stop additional exploration after sufficient evidence supports the requested outcome.

## Persistent project mode

When the user asks to persist a mode, run `jev init` once in the project, then run `jev mode <mode>`. Besides `.jev/config.json`, this writes a short managed block into `CLAUDE.md` and `AGENTS.md` between `<!-- jev:start -->` and `<!-- jev:end -->`, so later sessions load the mode without being told. Nothing outside those markers is touched. Pass `--no-memory` if the user does not want those files written. If a project's `CLAUDE.md` already carries a `jev mode:` block, that is the active mode -- follow it without re-reading the config.

## Picking a mode automatically

If the user asks for an automatic or "auto" mode, or asks which mode fits a task, run `jev classify "<their request>"` and use the mode it returns. Add `--apply` to persist it for the project.

It asks JEV to judge the work, not the wording, and it will not cheapen effort on a shaky answer: a downgrade below the confidence floor falls back to `full` and says so. Report the fallback when it happens rather than presenting the suggested mode as the decision. Each classification is one small JEV call, billed to the user's key and recorded in the ledger, so classify once per task rather than per step.

## Compaction

`jev compaction <on|off>` and `jev compact <transcript.json>` are separate from mode switching: they send tool call inputs and tool result text to TypeSafe's JEV model over the network (directly, or via Vercel AI Gateway) to score which tool calls and results are still needed. Never run `jev compaction on` or rely on the automatic compaction hook without the user explicitly asking for it — it costs money and sends conversation content off the machine, which mode switching never does. If the user asks to save tokens or reduce cost, mode switching and `jev-audit` are the default answer; bring up compaction only if they ask about it or ask why context is expensive.

`jev mode off` force-disables `jev compact`/`jev compaction` in one command, regardless of their own state — the one guaranteed way to stop all JEV calls from the CLI. It does not reach the separate Claude Code hook (`hooks/compact.mjs`), which has its own `enabled` switch (default off, set via Claude Code's `/config`) because the hook cannot read `.jev/config.json`. If the user asks to fully disable JEV calls in a Claude Code project, tell them both switches exist and that `jev mode off` alone does not cover the hook.

## Response

State active mode, policies applied, evidence collected, and any escalation. Keep the response compact unless the user requests a detailed audit.
