import { noulAnswer } from "./jevProtocol.mjs";

/**
 * @typedef {object} ToolUse
 * @property {string} tool_use_id
 * @property {string} tool
 * @property {Record<string, unknown>} input
 * @property {string} [text]
 * @property {boolean} [isError]
 *
 * @typedef {object} ToolResult
 * @property {string} tool_use_id
 * @property {string} text
 * @property {boolean} [isError]
 *
 * @typedef {object} Message
 * @property {'user'|'assistant'} role
 * @property {string} text
 * @property {ToolUse[]} toolUses
 * @property {ToolResult[]} [toolResults]
 *
 * @typedef {object} JevResponse
 * @property {Record<string, {noul?: number}>} answers
 *
 * @typedef {object} JevAsker
 * @property {(state: string|object, questions: Record<string, object>) => Promise<JevResponse>} ask
 */

const DEFAULT_OPTIONS = Object.freeze({
  backend: "typesafe",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  truncateHeadChars: 300,
  // A call whose entire footprint is smaller than this is never dropped.
  // Measured: dropping a 113-char `Read limits.ts` saved 0.4% of a
  // transcript and lost the one number needed to continue the task. The
  // information risk is not worth the bytes.
  minDropChars: 300,
  // Characters of each tool result shown to Jev when it scores that result.
  resultExcerptChars: 240,
  // Requests in flight at once, and the ceiling on how many a single
  // compaction may make. Every request repeats the whole fitted state, so an
  // unbounded fan-out multiplies input-token spend.
  maxConcurrentRequests: 4,
  // Measured: a 401-message session with 200 tool calls needs 14 requests at
  // these defaults, so a ceiling of 12 refused an ordinary long session --
  // the exact case compaction is for. 24 covers roughly 340 calls; past that
  // the refusal is the right answer and the message says what proceeding
  // would cost.
  maxRequests: 24,
  requestTimeoutMs: 60000,
  // The goal is derived from the newest user turns, and users paste logs and
  // stack traces into prompts. Uncapped it is the one part of the state no
  // fitting stage could shrink, so a single paste made the whole state
  // unfittable and compaction failed outright -- on exactly the long, messy
  // sessions it exists for. It is also duplicated in `history`, so every
  // uncapped byte was paid for twice in every request.
  maxGoalChars: 2000
});

const TRUNCATE_DETAIL_STAGES = [1000, 200, 60];
const ABRIDGE_HEAD_CHARS = 200;
const ABRIDGE_TAIL_CHARS = 100;
const ABRIDGE_TEXT_THRESHOLD = 400;
const ABRIDGE_HEAD_RATIO = ABRIDGE_HEAD_CHARS / (ABRIDGE_HEAD_CHARS + ABRIDGE_TAIL_CHARS);
// What the goal is cut to when the state still will not fit after the
// history has been reduced. Enough to keep the task recognizable; the
// scoring questions carry the rest of the meaning.
const GOAL_FIT_CHARS = 400;
// Tool input and result detail kept on pinned entries in the last-resort stage.
const PINNED_DETAIL_CHARS = 200;

/**
 * Head-and-tail abridgement to `maxChars`. Both ends are kept because the
 * ends of a prompt or a message carry the task and its conclusion, while
 * the middle of a pasted log carries neither.
 */
function abridgeText(text, maxChars, headRatio = ABRIDGE_HEAD_RATIO) {
  if (!text || text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * headRatio));
  const tail = Math.max(0, maxChars - head);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}…[${omitted} chars omitted]…${tail > 0 ? text.slice(-tail) : ""}`;
}

/** Fills in default compaction options and resolves a goal when none is given. */
export function resolveOptions(options, messages = []) {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  if (!resolved.goal) {
    const recentPrompts = messages
      .filter((message) => message.role === "user" && message.text)
      .slice(-3)
      .map((message) => message.text);
    resolved.goal = abridgeText(recentPrompts.join("\n"), resolved.maxGoalChars) || "Continue the current task.";
  }
  return resolved;
}

function messageChars(message) {
  let chars = message.text?.length ?? 0;
  for (const tool of message.toolUses ?? []) {
    chars += JSON.stringify(tool.input ?? {}).length + (tool.text?.length ?? 0);
  }
  for (const result of message.toolResults ?? []) {
    chars += result.text?.length ?? 0;
  }
  return chars;
}

/**
 * Pairs every `tool_use` with its `tool_result` by `tool_use_id` and marks
 * which calls are pinned (the first message, or one of the newest
 * `preserveRecentMessages` messages) and so never a compaction candidate.
 * @param {Message[]} messages
 * @param {number} preserveRecentMessages
 */
export function collectToolCalls(messages, preserveRecentMessages) {
  const resultIndexByToolUseId = new Map();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      resultIndexByToolUseId.set(result.tool_use_id, index);
    }
  });

  const pinnedFrom = Math.max(1, messages.length - preserveRecentMessages);
  const calls = [];
  let sequence = 0;
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses ?? []) {
      sequence += 1;
      const resultIndex = resultIndexByToolUseId.get(tool.tool_use_id) ?? callIndex;
      const pinned = callIndex === 0 || callIndex >= pinnedFrom || resultIndex >= pinnedFrom;
      const resultEntry = messages[resultIndex]?.toolResults?.find((r) => r.tool_use_id === tool.tool_use_id);
      calls.push({
        id: `t${sequence}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input ?? {},
        callIndex,
        resultIndex,
        resultText: resultEntry?.text ?? "",
        resultChars: resultEntry?.text?.length ?? 0,
        isError: Boolean(tool.isError) || Boolean(resultEntry?.isError),
        pinned
      });
    }
  });
  return calls;
}

/**
 * Character-based token estimate, calibrated to land a little above what
 * Jev reports: no tokenizer is used.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    if (/[a-zA-Z]/.test(char)) tokens += 1 / 6;
    else if (/[0-9]/.test(char)) tokens += 0.5;
    else tokens += 1;
  }
  return Math.ceil(tokens);
}

/**
 * What JEV is shown of a tool result when scoring it.
 *
 * A bare `ok, 4213 chars (omitted)` asks the model whether output it has
 * never seen is safe to discard. Measured live on two stale results of
 * near-identical length, blind scoring ranked them backwards: a failed
 * production migration scored 0.30 and a passing smoke test 0.45, so the
 * failure would have been dropped. With a 240-char excerpt the same pair
 * scored 0.51 and 0.21. `excerptChars` is what the fitting stages shrink
 * first, since it is the most droppable detail in the state.
 */
function toolResultNote(call, excerptChars) {
  const kind = call.isError ? "error" : "ok";
  if (excerptChars <= 0 || call.resultChars === 0) {
    return `${kind}, ${call.resultChars} chars (omitted)`;
  }
  const head = call.resultText.slice(0, excerptChars).replace(/\s+/g, " ").trim();
  const remaining = call.resultChars - Math.min(call.resultChars, excerptChars);
  return remaining > 0
    ? `${kind}, ${call.resultChars} chars, starts: ${head}… (+${remaining} more omitted)`
    : `${kind}: ${head}`;
}

/**
 * Builds the `{context, goal, history}` state sent to Jev. Tool results are
 * reduced to a bounded excerpt; nothing is summarized or rewritten.
 * @param {Message[]} messages
 * @param {ReturnType<typeof collectToolCalls>} calls
 * @param {string} goal
 * @param {number} [excerptChars] characters of each result shown to Jev
 */
export function buildState(messages, calls, goal, excerptChars = DEFAULT_OPTIONS.resultExcerptChars) {
  const callsByMessage = new Map();
  for (const call of calls) {
    const list = callsByMessage.get(call.callIndex) ?? [];
    list.push(call);
    callsByMessage.set(call.callIndex, list);
  }

  const history = messages.map((message, index) => {
    const entry = { i: index, role: message.role, text: message.text ?? "" };
    const messageCalls = callsByMessage.get(index);
    if (messageCalls && messageCalls.length > 0) {
      entry.tool_calls = messageCalls.map((call) => ({
        id: call.id,
        tool: call.tool,
        input: JSON.stringify(call.input),
        result: toolResultNote(call, excerptChars)
      }));
    }
    return entry;
  });

  return {
    context:
      "Score which tool calls and tool results in this transcript are still needed to continue the task. Each result is shown as a bounded excerpt of its real output.",
    goal,
    history
  };
}

function stateTokens(state) {
  return estimateTokens(JSON.stringify(state));
}

function isEntryPinned(entry, pinnedFrom) {
  return entry.i === 0 || entry.i >= pinnedFrom;
}

/**
 * Fits the state into `maxStateTokens`, applying staged reductions oldest
 * non-pinned entry first, each stage only if the previous one still leaves
 * the state too large. Throws if it still does not fit.
 */
export function fitState(state, options) {
  const pinnedFrom = Math.max(1, state.history.length - options.preserveRecentMessages);
  let current = state;
  let stage = "full";
  if (stateTokens(current) <= options.maxStateTokens) return { state: current, tokens: stateTokens(current), stage };

  // Call detail -- the tool input and the result excerpt -- is the most
  // droppable content in the state, so it shrinks before message text does.
  for (const limit of TRUNCATE_DETAIL_STAGES) {
    current = {
      ...current,
      history: current.history.map((entry) => {
        if (isEntryPinned(entry, pinnedFrom) || !entry.tool_calls) return entry;
        return {
          ...entry,
          tool_calls: entry.tool_calls.map((call) => {
            if (typeof call === "string") return call;
            const shrunk = { ...call };
            if (call.input.length > limit) shrunk.input = `${call.input.slice(0, limit)}…`;
            if (call.result.length > limit) shrunk.result = `${call.result.slice(0, limit)}…`;
            return shrunk;
          })
        };
      })
    };
    stage = `truncate-detail-${limit}`;
    if (stateTokens(current) <= options.maxStateTokens) return { state: current, tokens: stateTokens(current), stage };
  }

  current = {
    ...current,
    history: current.history.map((entry) => {
      if (isEntryPinned(entry, pinnedFrom) || entry.text.length <= ABRIDGE_TEXT_THRESHOLD) return entry;
      return { ...entry, text: abridgeText(entry.text, ABRIDGE_HEAD_CHARS + ABRIDGE_TAIL_CHARS) };
    })
  };
  stage = "abridge-text";
  if (stateTokens(current) <= options.maxStateTokens) return { state: current, tokens: stateTokens(current), stage };

  // The goal is normally capped at build time, but a caller can pass one
  // directly, so it has to be reducible here too -- otherwise it is again
  // the one part of the state nothing can shrink.
  if (current.goal && current.goal.length > GOAL_FIT_CHARS) {
    current = { ...current, goal: abridgeText(current.goal, GOAL_FIT_CHARS) };
    stage = "abridge-goal";
    if (stateTokens(current) <= options.maxStateTokens) return { state: current, tokens: stateTokens(current), stage };
  }

  for (let index = 0; index < current.history.length; index += 1) {
    const entry = current.history[index];
    if (isEntryPinned(entry, pinnedFrom)) continue;
    current.history[index] = { i: entry.i, role: entry.role, text: `[… ${messageEntryChars(entry)} chars omitted …]` };
    stage = "collapse-old-messages";
    if (stateTokens(current) <= options.maxStateTokens) return { state: current, tokens: stateTokens(current), stage };
  }

  for (let index = 0; index < current.history.length; index += 1) {
    const entry = current.history[index];
    if (isEntryPinned(entry, pinnedFrom) || !entry.tool_calls) continue;
    current.history[index] = {
      ...entry,
      tool_calls: entry.tool_calls.map((call) =>
        typeof call === "string" ? call : `${call.id} ${call.tool} ${call.input.slice(0, 60)} → ${call.result}`
      )
    };
    stage = "flatten-tool-calls";
    if (stateTokens(current) <= options.maxStateTokens) return { state: current, tokens: stateTokens(current), stage };
  }

  // Last resort: shrink the pinned entries too. Pinning protects recent
  // messages from being *dropped from the transcript*, which applyDecisions
  // does by tool call -- it never touches `message.text`. So abridging a
  // pinned message here only narrows what Jev is shown while scoring, and
  // costs nothing in the output. Without this a 200KB paste in one of the
  // newest messages was still unfittable after every other stage.
  if (stateTokens(current) > options.maxStateTokens) {
    current = {
      ...current,
      history: current.history.map((entry) => {
        if (!isEntryPinned(entry, pinnedFrom)) return entry;
        const shrunk = { ...entry, text: abridgeText(entry.text, ABRIDGE_HEAD_CHARS + ABRIDGE_TAIL_CHARS) };
        if (Array.isArray(entry.tool_calls)) {
          shrunk.tool_calls = entry.tool_calls.map((call) => {
            if (typeof call === "string") return abridgeText(call, PINNED_DETAIL_CHARS);
            return { ...call, input: abridgeText(call.input, PINNED_DETAIL_CHARS), result: abridgeText(call.result, PINNED_DETAIL_CHARS) };
          });
        }
        return shrunk;
      })
    };
    stage = "abridge-pinned";
    if (stateTokens(current) <= options.maxStateTokens) return { state: current, tokens: stateTokens(current), stage };
  }

  current = { ...current, history: current.history.filter((entry) => isEntryPinned(entry, pinnedFrom) || entry.text || entry.tool_calls) };
  stage = "drop-empty-entries";
  const tokens = stateTokens(current);
  if (tokens > options.maxStateTokens) {
    throw new Error(`Jev state does not fit maxStateTokens (${tokens} > ${options.maxStateTokens}) after all fitting stages`);
  }
  return { state: current, tokens, stage };
}

function messageEntryChars(entry) {
  const callsChars = (entry.tool_calls ?? []).reduce((total, call) => total + (typeof call === "string" ? call.length : JSON.stringify(call).length), 0);
  return entry.text.length + callsChars;
}

// Each question asks exactly one thing and says what true and false mean.
// Measured against the live model: without criteria, and with the result
// question double-barrelled ("...still needed, or would re-running be
// enough?"), every call scored in a narrow 0.14-0.46 band regardless of
// relevance — no signal, so compaction degenerated into dropping everything
// unpinned. With these, stale exploration lands near 0.1 while a still
// load-bearing edit clears the threshold.
const CALL_CRITERIA = Object.freeze({
  true: "The fact of this call, or its input, is still load-bearing: removing it would lose a decision, a path taken, a constraint, or a change already applied.",
  false: "Superseded, redundant, or purely exploratory: the task can continue correctly without any record of this call."
});

const RESULT_CRITERIA = Object.freeze({
  true: "The exact contents are still needed: specific values, paths, errors, or text that would be lost or expensive to recover.",
  false: "No longer needed verbatim: already acted on, summarized in the surrounding text, or cheaply obtainable by re-running the tool."
});

function callQuestions(call) {
  // Both refer to the call by id only; the state already carries every
  // call's tool and input, so repeating them here is paid-for duplication.
  return {
    [`${call.id}:call`]: {
      type: "noul",
      instructions: `Does the assistant still need to know that tool call ${call.id} (${call.tool}) was made, to continue the task in "goal"?`,
      criteria: CALL_CRITERIA
    },
    [`${call.id}:result`]: {
      type: "noul",
      instructions: `Must the full verbatim output of tool call ${call.id} (${call.tool}) be preserved to continue the task in "goal"?`,
      criteria: RESULT_CRITERIA
    }
  };
}

/**
 * Splits non-pinned calls into batches of questions so each request (state
 * plus that batch's questions) stays under `maxRequestTokens`.
 */
export function batchCalls(calls, state, options) {
  const baseTokens = stateTokens(state);
  const batches = [];
  let currentBatch = [];
  let currentTokens = baseTokens;

  for (const call of calls) {
    const questions = callQuestions(call);
    const questionTokens = estimateTokens(JSON.stringify(questions));
    // A batch is never allowed to start over budget: splitting only helps
    // when the state plus one call's questions fits at all. Sending it
    // anyway would spend tokens on a request the provider will reject.
    if (baseTokens + questionTokens > options.maxRequestTokens) {
      throw new Error(
        `A single call's questions do not fit maxRequestTokens (state ${baseTokens} + questions ${questionTokens} > ${options.maxRequestTokens}). Raise maxRequestTokens or lower maxStateTokens.`
      );
    }
    if (currentBatch.length > 0 && currentTokens + questionTokens > options.maxRequestTokens) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = baseTokens;
    }
    currentBatch.push(call);
    currentTokens += questionTokens;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

/** The text a truncated result would carry, or null when it saves nothing. */
function truncatedResultText(text, truncateHeadChars) {
  const head = text.slice(0, truncateHeadChars);
  const omitted = text.length - head.length;
  if (omitted <= 0) return null;
  const replacement = `${head}\n[… ${omitted} chars omitted …]`;
  return replacement.length < text.length ? replacement : null;
}

/** One call's decision against `keepThreshold`. */
export function decideCall(answers, call, options) {
  if (call.pinned) {
    return { id: call.id, tool: call.tool, action: "keep", reason: "pinned", keepCall: 1, keepResult: 1 };
  }
  const keepCall = noulAnswer(answers, `${call.id}:call`);
  const keepResult = noulAnswer(answers, `${call.id}:result`);
  if (keepResult >= options.keepThreshold) {
    return { id: call.id, tool: call.tool, action: "keep", reason: "kept", keepCall, keepResult };
  }
  // Dropping a call only pays if it frees real space. Below the floor the
  // saving is noise and the downside is losing an exact value -- a path, a
  // limit, an error string -- that nothing else in the transcript records.
  const footprint = JSON.stringify(call.input ?? {}).length + call.resultChars;
  if (keepCall < options.keepThreshold && footprint <= (options.minDropChars ?? 0)) {
    return { id: call.id, tool: call.tool, action: "keep", reason: "kept_small", keepCall, keepResult };
  }
  if (keepCall >= options.keepThreshold) {
    // Truncating a result that is already at or under the head limit adds an
    // omission note without removing anything, which would grow the
    // transcript. Keep such a result verbatim instead.
    const savesNothing = truncatedResultText("x".repeat(call.resultChars), options.truncateHeadChars) === null;
    if (savesNothing) {
      return { id: call.id, tool: call.tool, action: "keep", reason: "kept_short", keepCall, keepResult };
    }
    return { id: call.id, tool: call.tool, action: "drop_result", reason: "result_dropped", keepCall, keepResult };
  }
  return { id: call.id, tool: call.tool, action: "drop_call", reason: "call_dropped", keepCall, keepResult };
}

/**
 * Rebuilds the message list from decisions. A message that loses all its
 * content is removed; untouched messages are returned as the same objects.
 */
export function applyDecisions(messages, decisions, options) {
  const decisionByToolUseId = new Map(decisions.map((decision) => [decision.tool_use_id, decision]));

  return messages
    .map((message) => {
      const toolUses = message.toolUses ?? [];
      const toolResults = message.toolResults ?? [];
      if (toolUses.length === 0 && toolResults.length === 0) return message;

      let changed = false;
      const nextToolUses = [];
      for (const tool of toolUses) {
        const decision = decisionByToolUseId.get(tool.tool_use_id);
        if (decision?.action === "drop_call") {
          changed = true;
          continue;
        }
        nextToolUses.push(tool);
      }

      const nextToolResults = [];
      for (const result of toolResults) {
        const decision = decisionByToolUseId.get(result.tool_use_id);
        if (decision?.action === "drop_call") {
          changed = true;
          continue;
        }
        if (decision?.action === "drop_result") {
          const truncated = truncatedResultText(result.text, options.truncateHeadChars);
          if (truncated === null) {
            // Nothing to save: keep it verbatim rather than grow it.
            nextToolResults.push(result);
            continue;
          }
          changed = true;
          nextToolResults.push({ ...result, text: truncated });
          continue;
        }
        nextToolResults.push(result);
      }

      if (!changed) return message;

      const hasContent = message.text || nextToolUses.length > 0 || nextToolResults.length > 0;
      if (!hasContent) return null;

      // Spread the original first: a host transcript carries fields this
      // engine knows nothing about (ids, timestamps, provider metadata), and
      // rebuilding from a fixed field list would silently drop them.
      const rebuilt = { ...message, toolUses: nextToolUses };
      if (nextToolResults.length > 0) rebuilt.toolResults = nextToolResults;
      else delete rebuilt.toolResults;
      return rebuilt;
    })
    .filter(Boolean);
}

/**
 * Runs `task` over `items`, at most `limit` in flight, preserving order.
 *
 * On the first failure the remaining work is abandoned rather than merely
 * unawaited: every request costs money, and `Promise.all` rejecting does
 * nothing to stop workers that are already looping through the queue.
 */
async function mapWithConcurrency(items, limit, task) {
  const bounded = Math.max(1, Math.min(limit || 1, items.length));
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: bounded }, async () => {
      while (next < items.length) {
        if (failed) return;
        const index = next;
        next += 1;
        try {
          results[index] = await task(items[index]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    })
  );
  return results;
}

/**
 * Runs the full pipeline: pair calls, fit state, batch and ask Jev, apply
 * decisions. Pinned calls never reach Jev.
 * @param {Message[]} messages
 * @param {JevAsker} asker
 * @param {object} [rawOptions]
 */
export async function compact(messages, asker, rawOptions = {}) {
  const started = Date.now();
  const options = resolveOptions(rawOptions, messages);
  const charsBefore = messages.reduce((total, message) => total + messageChars(message), 0);

  const calls = collectToolCalls(messages, options.preserveRecentMessages);
  const nonPinned = calls.filter((call) => !call.pinned);

  let decisions = calls
    .filter((call) => call.pinned)
    .map((call) => ({ ...decideCall({}, call, options), tool_use_id: call.tool_use_id }));

  let stateStage = "";
  let stateTokenCount = 0;
  let requests = 0;
  let usage = null;

  if (nonPinned.length > 0) {
    const state = buildState(messages, calls, options.goal, options.resultExcerptChars);
    const fitted = fitState(state, options);
    stateStage = fitted.stage;
    stateTokenCount = fitted.tokens;

    const batches = batchCalls(nonPinned, fitted.state, options);
    // Every request repeats the whole fitted state, so the request count is
    // the cost multiplier. Refuse a fan-out that would spend without bound
    // rather than discovering it on the bill.
    if (batches.length > options.maxRequests) {
      throw new Error(
        `Compaction would need ${batches.length} requests, over maxRequests (${options.maxRequests}). Each repeats the ~${fitted.tokens}-token state, so proceeding would send about ${(batches.length * fitted.tokens).toLocaleString()} input tokens. Raise maxRequests to ${batches.length} to accept that, or lower maxStateTokens so more questions fit per request.`
      );
    }
    requests = batches.length;
    const answerSets = await mapWithConcurrency(batches, options.maxConcurrentRequests, (batch) =>
      asker.ask(fitted.state, Object.assign({}, ...batch.map(callQuestions)))
    );
    const answers = Object.assign({}, ...answerSets.map((response) => response.answers));
    usage = answerSets.reduce(
      (total, response) => ({
        inputTokens: total.inputTokens + (response.usage?.input_tokens ?? 0),
        outputTokens: total.outputTokens + (response.usage?.output_tokens ?? 0)
      }),
      { inputTokens: 0, outputTokens: 0 }
    );

    decisions = decisions.concat(
      nonPinned.map((call) => ({ ...decideCall(answers, call, options), tool_use_id: call.tool_use_id }))
    );
  }

  const outputMessages = applyDecisions(messages, decisions, options);
  const charsAfter = outputMessages.reduce((total, message) => total + messageChars(message), 0);

  const stats = {
    messagesBefore: messages.length,
    messagesAfter: outputMessages.length,
    charsBefore,
    charsAfter,
    calls: nonPinned.length,
    kept: decisions.filter((d) => d.action === "keep" && d.reason !== "pinned").length,
    resultsDropped: decisions.filter((d) => d.action === "drop_result").length,
    callsDropped: decisions.filter((d) => d.action === "drop_call").length,
    pinned: calls.length - nonPinned.length,
    stateTokens: stateTokenCount,
    stateStage,
    requests,
    ms: Date.now() - started
  };

  return { messages: outputMessages, decisions, stats, usage };
}

/** Fraction of characters removed, 0 when there was nothing to remove. */
export function reductionRatio(result) {
  const { charsBefore, charsAfter } = result.stats;
  if (charsBefore === 0) return 0;
  return (charsBefore - charsAfter) / charsBefore;
}

export function summarize(result) {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : "",
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : "",
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : "",
    stats.pinned > 0 ? `${stats.pinned} pinned` : ""
  ].filter(Boolean);
  return `${Math.round(reductionRatio(result) * 100)}% reduction; ${parts.join(", ") || "no tool calls"}; state ~${stats.stateTokens} tokens (${stats.stateStage || "n/a"}) in ${stats.requests} request(s)`;
}
