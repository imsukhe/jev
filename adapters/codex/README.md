# Codex adapter

Codex discovers skills from a plugin's `skills/` directory or from `.agents/skills/` in a project hierarchy.

## Plugin source

Use the root plugin manifest and its `.codex-plugin/plugin.json` fallback when installing JEV AI from a local or public plugin source. The skills are invoked explicitly as:

```text
$jev full
$jev-audit
```

## Project-only skills

Copy these folders into the target repository:

```text
skills/jev       -> .agents/skills/jev
skills/jev-audit -> .agents/skills/jev-audit
```

Codex uses progressive disclosure: it sees skill metadata first and loads full instructions when the skill is used. Keep the global mode instruction small and put detailed audit guidance in `jev-audit`.

## Compaction

The automatic `session.compact`/`turn.complete` hook (`hooks/compact.mjs`) is Claude-Code-only — Codex has no equivalent function-hook mechanism here. `jev compact <transcript.json>` still works manually in a Codex project; it is a plain CLI call, host-independent. See [compaction](../../README.md#compaction).

See [OpenAI's skill documentation](https://learn.chatgpt.com/docs/build-skills) for current discovery and explicit invocation behavior.
