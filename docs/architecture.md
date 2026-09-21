# Architecture

Three layers with separate responsibilities.

| Layer | Responsibility | Does not do |
| --- | --- | --- |
| Skills | Set cost-aware working behavior in an agent session. | Enforce billing, select an unavailable model, or bypass host permissions. |
| CLI | Store project mode, record locally supplied usage, and drive compaction. | Send telemetry, or call anything remote outside compaction. |
| Compaction engine | Turn a transcript into JEV questions and apply the answers. | Reimplement JEV's scoring, or decide anything JEV was not asked. |

## Policy

The policy must be host-neutral. It defines evidence thresholds, output limits, context selection, escalation rules, and required verification. Host adapters translate a shared mode into the invocation syntax each host supports.

`full` is the default because it reduces common waste while keeping focused verification. `ultra` is for bounded, routine work and must escalate for security, irreversible operations, unclear requirements, failed verification, or cross-system changes.

## Classifying a mode

`jev classify` asks JEV a single `choice` question over the modes, with each mode's meaning spelled out in `criteria` and an instruction to judge the work rather than the tone of the request. Routing is what a System One model is for, and it is accurate here: twelve hand-labelled prompts, twelve agreements, one 1.2s request.

The design that matters is what happens when it is wrong. Given "tiny fix: change the auth check from === to == in login.ts" it answered `ultra` -- a security change waved through as trivial -- but at 0.60 confidence, where every correct answer in that run scored 0.93 or better. So the guard is asymmetric: a *downgrade* away from the careful mode requires `minConfidence` (0.85 by default) and otherwise falls back to `full`, while choosing `full` needs no confidence at all, because `full` is already the cautious answer. An unrecognized or missing choice falls back the same way rather than throwing. With that rule the adversarial set -- casually-phrased data loss, alarming-sounding typos -- scores 10/10.

Classification is one small JEV call and is billed and recorded like any other, under `host: jev` with `task: classify`.

## Delivering a mode

A mode is only worth setting if something reads it. `.jev/config.json` is not loaded by any session, and the Claude Code hook sandbox has no filesystem access, so neither path can carry the mode into an agent's context. `lib/modeMemory.mjs` closes that gap by writing a marker-delimited block into `CLAUDE.md` and `AGENTS.md`, which both hosts load themselves.

The rules that make it safe to point at a file the user also edits: only the text between `<!-- jev:start -->` and `<!-- jev:end -->` is ever written; an existing block is replaced in place, never duplicated; an unchanged mode writes nothing, so re-running does not dirty a git tree; a malformed or unterminated block raises an error instead of being rewritten around; and `off` removes the block, restoring the file byte-for-byte. The block is kept deliberately short, since it is paid for in every session of that project.

`memoryFiles` entries are resolved inside the project and refused otherwise: an absolute path, a `../` escape, or a symlinked `CLAUDE.md` would turn `jev mode` into a write pointed anywhere on the machine, and that config arrives with a cloned repository like any other project file.

Delivery is not enforcement. The agent honors the block as it honors any instruction; `off` is the only mode with a code-level guarantee, and it lives in the CLI rather than in the block.

## Local usage ledger

Records live in `.jev/usage.jsonl`. Every record has a host, model, timestamp, token counts, and optional measured cost. JSON Lines keeps it inspectable and append-only, while allowing later export to SQLite, OTLP, or a remote collector. Compaction writes its own JEV usage here under `host: jev`, so the cost of the wrapper's own calls shows up next to everything else.

## Compaction

This is the wrapper around TypeSafe's JEV model, and the only part of the repository that makes a network call.

`lib/compaction.mjs` holds the engine: pair every `tool_use` with its `tool_result`, pin the first and newest messages, build a state that omits tool output, fit that state into `maxStateTokens` through staged reduction, batch two `noul` questions per candidate call under `maxRequestTokens`, and apply the returned probabilities against `keepThreshold` as keep / truncate-result / drop-call. Kept content is never rewritten, and a result is only truncated when truncation actually saves characters — a result already at or under `truncateHeadChars` stays verbatim (`kept_short`), since appending an omission note to it would grow the transcript instead of shrinking it.

Each backend names the model differently (`jev-latest` direct, `typesafe-ai/jev` through the gateway), so `jev compaction --backend` resets the model to that backend's own name unless `--model` pins one.

Question framing carries real weight, measured against the live model. Each axis is asked as one single-barrelled question with explicit `true`/`false` criteria. An earlier phrasing without criteria, whose result question asked two things at once, returned a flat 0.14–0.46 for every call regardless of relevance — no signal, so every unpinned call fell below the threshold and compaction degenerated into dropping everything not pinned. With criteria, stale exploration lands near 0.1 while a still load-bearing edit clears 0.5.

Every request repeats the whole fitted state, so the request count is the cost multiplier, not an implementation detail: `maxConcurrentRequests` bounds how many run at once and `maxRequests` refuses a fan-out outright rather than discovering its cost on the bill. Each request carries a `requestTimeoutMs` deadline on both sides -- the Node clients hold it open until the response body is read, not merely until headers arrive, and the hook races its own `$.http.fetch` against the engine's clock -- because a stalled call would otherwise leave compaction pending forever and the hook would never reach the fallback it advertises. A failed batch also stops the queue: the remaining requests are abandoned rather than merely unawaited, since each one costs money.

Results are shown to JEV as a bounded `resultExcerptChars` excerpt rather than a bare `ok, 4213 chars (omitted)` note. Scoring a result the model has never seen cannot distinguish outputs by content, only by length. Measured live on two stale results of near-identical length — a failed production migration (98 chars) and a passing smoke test (90 chars) — blind scoring ranked them backwards: the failure at 0.30 and the passing test at 0.45, so the output the task still depended on would have been dropped. With a 240-char excerpt the same pair scored 0.51 and 0.21, keeping the failure and discarding the noise.

The excerpt is not free: it grew one 27-message transcript's state from 1613 to 2346 tokens without changing any decision there, because every result in it genuinely was spent. It earns its cost on the transcripts where a result's contents, not its size, decide whether it matters. It is also the first thing the fitting stages shrink, so a tight `maxStateTokens` spends the budget on conversation rather than on tool output.

`maxStateTokens` trades cost against decision quality. The staged reduction keeps the state affordable, but a state collapsed hard enough to reach `collapse-old-messages` gives JEV less to judge relevance with, and it drops more aggressively. Lower the budget to save money, not to improve pruning.

The engine imports no client and no `node:` module on purpose: the Claude Code hook loads it inside a sandbox with no filesystem and no `process`, and builds its own asker over `$.http.fetch`. `lib/compactMessages.mjs` is the Node-side entry point that selects a backend, so nothing Node-shaped is ever pulled into that sandbox. `lib/jevProtocol.mjs` is the wire contract. `lib/jevClient.mjs` calls TypeSafe directly; `lib/jevGatewayClient.mjs` calls the same model through Vercel AI Gateway and translates between JEV's `noul` question type and the gateway's generic `boolean` one. Both satisfy the same one-method asker interface, so the engine never branches on backend.

Two entry points: `jev compact` for a transcript file, and `hooks/compact.mjs` for Claude Code's `session.compact` / `turn.complete`. The hook falls back to Claude Code's built-in compaction on any error or insufficient measured reduction; it never throws out of a session.

Two independent on/off switches, not one, because they run in two different processes: `jev compaction on/off` and `jev mode` (`.jev/config.json`, read by the CLI) gate `jev compact`; the hook's own `enabled` userConfig option (Claude Code's `/config`) gates `hooks/compact.mjs`, since the hook sandbox has no filesystem access and cannot read `.jev/config.json`. `jev mode off` is the one absolute override on the CLI side: it force-disables `compaction.enabled`, so it always stops `jev compact` and `jev classify` — but it has no reach into the hook's switch, which must be turned off separately if it was ever turned on. Documentation that calls `off` a global kill switch is wrong, and was: stopping every JEV call in a project takes both switches.

## Test 0: does the work survive?

Reduction on its own proves nothing -- deleting the whole transcript reduces it 100%. The test that matters is whether a compacted transcript still answers the questions the original answered. `npm run fidelity` (needs a key; it makes live calls) runs that: six questions with known answers against three variants of the same 27-message debugging session.

| Variant | Answers preserved | Size |
| --- | --- | --- |
| Full transcript (control) | 6/6 | 18,645 chars |
| JEV-compacted | 6/6 | 1,647 chars (91% smaller) |
| Recency-truncated to the same budget | 4/6 | 924 chars |

The recency arm is the control that stops this from being self-congratulation: truncation at a comparable size loses both the order limit and the "never touch `src/generated`" constraint from the first message, which compaction keeps because the first message is pinned.

The grader is JEV reading each transcript, not a coding agent continuing the work, so this measures recoverability of the information rather than end-to-end task success. That is the property compaction must preserve, and it is cheap enough to re-run on every change, but it is a proxy: the stronger version runs a real agent from both transcripts and compares the work. Treat 6/6 as "nothing the questions asked for was lost", not as "the agent provably behaves identically".

The first run of this failed at 5/6, and the fix is `minDropChars`. JEV had scored a `Read limits.ts` call at 0.24 and the engine dropped it whole -- a 113-character call whose removal saved 0.4% of the transcript and took with it the only record of the limit the next task needed. Now a call whose input plus result is under `minDropChars` is never dropped (`kept_small`): below that size the saving is noise and the downside is losing an exact value nothing else records. It cost two points of reduction and bought back the answer.

## Non-goals

- No proxy or credential vault of our own. Compaction is a direct, user-keyed call to one model for one purpose; credentials stay in the user's environment and are never written to project files.
- No automatic transcript scraping outside the opt-in compaction hook, which only reads what Claude Code hands it at `session.compact` and never persists it.
- No dashboard.
- No claims of savings without before-and-after measurements.
