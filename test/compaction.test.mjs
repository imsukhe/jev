import assert from "node:assert/strict";
import test from "node:test";
import { applyDecisions, batchCalls, buildState, collectToolCalls, compact, decideCall, fitState, reductionRatio } from "../lib/compaction.mjs";

function transcript() {
  return [
    { role: "user", text: "Fix the failing test. Never edit src/generated.", toolUses: [] },
    {
      role: "assistant",
      text: "",
      toolUses: [{ tool_use_id: "toolu_1", tool: "Read", input: { file_path: "src/a.ts" } }]
    },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "x".repeat(500) }] },
    {
      role: "assistant",
      text: "",
      toolUses: [{ tool_use_id: "toolu_2", tool: "Read", input: { file_path: "src/b.ts" } }]
    },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_2", text: "y".repeat(500) }] },
    { role: "assistant", text: "Done, both files read.", toolUses: [] }
  ];
}

class FakeAsker {
  constructor(decisionsById) {
    this.decisionsById = decisionsById;
    this.calls = 0;
  }

  async ask(state, questions) {
    this.calls += 1;
    const answers = {};
    for (const name of Object.keys(questions)) {
      const [id, kind] = name.split(":");
      const decision = this.decisionsById[id] ?? { call: 1, result: 1 };
      answers[name] = { noul: kind === "call" ? decision.call : decision.result };
    }
    return { answers };
  }
}

test("collectToolCalls pins the first message and the newest N messages", () => {
  const messages = transcript();
  const calls = collectToolCalls(messages, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pinned, false, "t1's result (index 2) is older than the newest 2 preserved messages");
  assert.equal(calls[1].pinned, true, "t2's result (index 4) is one of the newest 2 preserved messages");
});

test("compact keeps a call whose result answer is above threshold", async () => {
  const messages = transcript();
  const asker = new FakeAsker({ t1: { call: 0.9, result: 0.9 } });
  const result = await compact(messages, asker, { preserveRecentMessages: 1 });
  const t1Decision = result.decisions.find((d) => d.id === "t1");
  assert.equal(t1Decision.action, "keep");
  const message = result.messages.find((m) => m.toolResults?.some((r) => r.tool_use_id === "toolu_1"));
  assert.equal(message.toolResults[0].text.length, 500);
});

test("compact truncates a result whose call is needed but output is not", async () => {
  const messages = transcript();
  const asker = new FakeAsker({ t1: { call: 0.9, result: 0.1 } });
  const result = await compact(messages, asker, { preserveRecentMessages: 1, truncateHeadChars: 50 });
  const decision = result.decisions.find((d) => d.id === "t1");
  assert.equal(decision.action, "drop_result");
  const message = result.messages.find((m) => m.toolUses.some((t) => t.tool_use_id === "toolu_1"));
  assert.ok(message, "the tool_use itself is kept");
  const resultMessage = result.messages.find((m) => m.toolResults?.some((r) => r.tool_use_id === "toolu_1"));
  assert.ok(resultMessage.toolResults[0].text.length < 500);
  assert.match(resultMessage.toolResults[0].text, /chars omitted/);
});

test("JEV sees a bounded excerpt of each result, not just its length", async () => {
  // Scoring a result the model has never seen makes "1 passing" and
  // "migration failed: rolled back production" identical at equal length.
  const messages = [
    { role: "user", text: "deploy it", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Bash", input: { command: "migrate" } }] },
    {
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: "toolu_1", text: "FATAL: migration failed, rolled back production" }]
    },
    ...Array.from({ length: 2 }, (_, i) => ({ role: "assistant", text: `note ${i}`, toolUses: [] }))
  ];
  const calls = collectToolCalls(messages, 1);
  const state = buildState(messages, calls, "deploy it", 240);
  const note = state.history[1].tool_calls[0].result;
  assert.match(note, /migration failed/, "the excerpt carries real content");

  // And with excerpts disabled it falls back to the bare length note.
  const bare = buildState(messages, calls, "deploy it", 0).history[1].tool_calls[0].result;
  assert.match(bare, /chars \(omitted\)/);
  assert.ok(!/migration failed/.test(bare));
});

test("a rebuilt message keeps host fields the engine does not know about", () => {
  // A real transcript carries ids and metadata; rebuilding from a fixed
  // field list would silently drop them.
  const messages = [
    {
      role: "assistant",
      text: "reading the file",
      uuid: "abc-123",
      timestamp: "2026-09-21T00:00:00Z",
      toolUses: [{ tool_use_id: "toolu_1", tool: "Read", input: {} }]
    }
  ];
  const decisions = [{ id: "t1", tool_use_id: "toolu_1", action: "drop_call", reason: "call_dropped" }];
  const [out] = applyDecisions([...messages, { role: "user", text: "next", toolUses: [] }], decisions, {
    truncateHeadChars: 300
  });
  assert.equal(out.uuid, "abc-123");
  assert.equal(out.timestamp, "2026-09-21T00:00:00Z");
  assert.deepEqual(out.toolUses, []);
});

test("batchCalls refuses a single call whose questions cannot fit maxRequestTokens", () => {
  const messages = transcript();
  const calls = collectToolCalls(messages, 1);
  const state = buildState(messages, calls, "goal");
  assert.throws(
    () => batchCalls(calls, state, { maxRequestTokens: 10 }),
    /do not fit maxRequestTokens/,
    "spending on a request the provider will reject is worse than failing early"
  );
});

test("a log pasted into a recent prompt does not make the state unfittable", async () => {
  // The bug this guards: the goal is derived from the newest user turns and
  // was uncapped, while fitState reduced only `history`. Measured at
  // defaults, a 200KB paste failed at 68357 > 25000 tokens even when every
  // history stage had done its job -- compaction simply stopped working on
  // the long, messy sessions it exists for.
  const paste = "x".repeat(200000);
  const messages = [{ role: "user", text: "start", toolUses: [] }];
  for (let index = 0; index < 20; index += 1) {
    messages.push({
      role: "assistant",
      text: `step ${index}`,
      toolUses: [{ tool_use_id: `u${index}`, tool: "Read", input: { path: `f${index}.ts` } }]
    });
    messages.push({ role: "user", text: "", toolResults: [{ tool_use_id: `u${index}`, text: "y".repeat(2000) }] });
  }
  messages.push({ role: "user", text: `here is the log:\n${paste}`, toolUses: [] });

  let seenGoal;
  const asker = {
    async ask(state, questions) {
      seenGoal = state.goal;
      return { answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: 0.9 }])) };
    }
  };
  const result = await compact(messages, asker, {});
  assert.ok(result.stats.stateTokens <= 25000, `state fits: ${result.stats.stateTokens}`);
  assert.ok(seenGoal.length <= 2100, `goal is capped, was ${seenGoal.length} chars`);
  assert.match(seenGoal, /chars omitted/, "the cut is marked, not silent");
  // The goal joins the last three user turns, so the earlier prompt leads
  // and the paste is what gets cut out of the middle.
  assert.ok(seenGoal.startsWith("start\nhere is the log:"), "the head of the prompts survives");
  assert.ok(!seenGoal.includes("x".repeat(2001)), "the paste itself is not carried whole");
});

test("an explicitly passed oversized goal is shrunk by a fitting stage", () => {
  // resolveOptions caps a derived goal, but a caller can pass one straight
  // in, so fitState has to be able to reduce it too.
  const state = { context: "c", goal: "g".repeat(200000), history: [{ i: 0, role: "user", text: "hi" }] };
  const fitted = fitState(state, { maxStateTokens: 25000, preserveRecentMessages: 6 });
  assert.equal(fitted.stage, "abridge-goal");
  assert.ok(fitted.tokens <= 25000);
  assert.ok(fitted.state.goal.length <= 500);
});

test("compact refuses a fan-out over maxRequests instead of spending on it", async () => {
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    ...Array.from({ length: 6 }, (_, i) => [
      { role: "assistant", text: "", toolUses: [{ tool_use_id: `toolu_${i}`, tool: "Read", input: { path: `f${i}` } }] },
      { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: `toolu_${i}`, text: "x".repeat(50) }] }
    ]).flat(),
    ...Array.from({ length: 2 }, (_, i) => ({ role: "assistant", text: `done ${i}`, toolUses: [] }))
  ];
  const asker = new FakeAsker({});
  await assert.rejects(
    () => compact(messages, asker, { preserveRecentMessages: 1, maxRequestTokens: 1200, maxRequests: 2 }),
    /over maxRequests/
  );
  assert.equal(asker.calls, 0, "nothing is sent once the fan-out is known to be too large");
});

test("one failed request stops the others from spending", async () => {
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    ...Array.from({ length: 6 }, (_, i) => [
      { role: "assistant", text: "", toolUses: [{ tool_use_id: `toolu_${i}`, tool: "Read", input: { path: `f${i}` } }] },
      { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: `toolu_${i}`, text: "x".repeat(50) }] }
    ]).flat(),
    ...Array.from({ length: 2 }, (_, i) => ({ role: "assistant", text: `done ${i}`, toolUses: [] }))
  ];
  let started = 0;
  const asker = {
    async ask() {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw new Error("upstream exploded");
    }
  };
  await assert.rejects(
    () => compact(messages, asker, { preserveRecentMessages: 1, maxRequestTokens: 1200, maxRequests: 20, maxConcurrentRequests: 2 }),
    /upstream exploded/
  );
  // Six batches, two workers: without the guard the workers keep dequeuing
  // and every remaining request is paid for after the failure is known.
  assert.ok(started <= 2, `expected the queue to stop after the first failure, saw ${started} requests`);
});

test("requests run no more than maxConcurrentRequests at a time", async () => {
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    ...Array.from({ length: 6 }, (_, i) => [
      { role: "assistant", text: "", toolUses: [{ tool_use_id: `toolu_${i}`, tool: "Read", input: { path: `f${i}` } }] },
      { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: `toolu_${i}`, text: "x".repeat(50) }] }
    ]).flat(),
    ...Array.from({ length: 2 }, (_, i) => ({ role: "assistant", text: `done ${i}`, toolUses: [] }))
  ];
  let inFlight = 0;
  let peak = 0;
  const asker = {
    async ask(state, questions) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const answers = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: 0.9 };
      return { answers };
    }
  };
  const result = await compact(messages, asker, {
    preserveRecentMessages: 1,
    maxRequestTokens: 1200,
    maxRequests: 20,
    maxConcurrentRequests: 2
  });
  assert.ok(result.stats.requests > 2, "the transcript really did split into several requests");
  assert.ok(peak <= 2, `expected at most 2 in flight, saw ${peak}`);
});

test("each call asks one single-barrelled question per axis, with explicit true/false criteria", async () => {
  // Measured against the live model: criteria-less, double-barrelled questions
  // returned a flat 0.14-0.46 for every call regardless of relevance, which
  // collapses compaction into "drop everything unpinned". Guard that framing.
  const messages = transcript();
  let captured;
  const asker = {
    async ask(state, questions) {
      captured = questions;
      const answers = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: 0.9 };
      return { answers };
    }
  };
  await compact(messages, asker, { preserveRecentMessages: 1 });

  const names = Object.keys(captured);
  assert.equal(names.length, 4, "two questions per non-pinned call");
  for (const name of names) {
    const question = captured[name];
    assert.equal(question.type, "noul");
    assert.ok(question.criteria?.true, `${name} states what true means`);
    assert.ok(question.criteria?.false, `${name} states what false means`);
    assert.ok(
      !/\bor would\b|\bor is\b/.test(question.instructions),
      `${name} must ask one thing, not two: ${question.instructions}`
    );
  }
});

test("a result shorter than truncateHeadChars is kept verbatim, never grown by an omission note", async () => {
  const messages = [
    { role: "user", text: "run the test", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Bash", input: { command: "npm test" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "1 passing (12ms)" }] },
    ...Array.from({ length: 2 }, (_, i) => ({ role: "assistant", text: `done ${i}`, toolUses: [] }))
  ];
  // Jev says the call matters but its output does not -- the drop_result branch.
  const asker = new FakeAsker({ t1: { call: 0.9, result: 0.1 } });
  const result = await compact(messages, asker, { preserveRecentMessages: 1, truncateHeadChars: 300 });

  const decision = result.decisions.find((d) => d.id === "t1");
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "kept_short");

  const resultMessage = result.messages.find((m) => m.toolResults?.some((r) => r.tool_use_id === "toolu_1"));
  assert.equal(resultMessage.toolResults[0].text, "1 passing (12ms)", "left byte-for-byte alone");
  assert.ok(result.stats.charsAfter <= result.stats.charsBefore, "compaction must never grow a transcript");
  assert.ok(reductionRatio(result) >= 0, "reduction ratio must never go negative");
});

test("truncateHeadChars 0 still does not grow a tiny result", async () => {
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Bash", input: {} }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "ok" }] },
    ...Array.from({ length: 2 }, (_, i) => ({ role: "assistant", text: `done ${i}`, toolUses: [] }))
  ];
  const asker = new FakeAsker({ t1: { call: 0.9, result: 0.1 } });
  const result = await compact(messages, asker, { preserveRecentMessages: 1, truncateHeadChars: 0 });
  assert.ok(result.stats.charsAfter <= result.stats.charsBefore);
});

test("a call too small to be worth dropping is kept, even when Jev says drop", async () => {
  // Test 0 found this: dropping a 113-char `Read limits.ts` saved 0.4% of a
  // transcript and lost the only record of the value the next task needed.
  const messages = [
    { role: "user", text: "fix the limit bug", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Read", input: { file_path: "limits.ts" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "export const LIMIT = 1000;" }] },
    ...Array.from({ length: 2 }, (_, i) => ({ role: "assistant", text: `step ${i}`, toolUses: [] }))
  ];
  const asker = new FakeAsker({ t1: { call: 0.1, result: 0.1 } });
  const result = await compact(messages, asker, { preserveRecentMessages: 1, minDropChars: 300 });
  const decision = result.decisions.find((d) => d.id === "t1");
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "kept_small");
  const kept = result.messages.find((m) => m.toolResults?.some((r) => r.tool_use_id === "toolu_1"));
  assert.match(kept.toolResults[0].text, /LIMIT = 1000/, "the exact value survives");
});

test("a large call is still dropped when Jev says so", async () => {
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Bash", input: { command: "ls -R" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "x".repeat(4000) }] },
    ...Array.from({ length: 2 }, (_, i) => ({ role: "assistant", text: `step ${i}`, toolUses: [] }))
  ];
  const asker = new FakeAsker({ t1: { call: 0.1, result: 0.1 } });
  const result = await compact(messages, asker, { preserveRecentMessages: 1, minDropChars: 300 });
  assert.equal(result.decisions.find((d) => d.id === "t1").action, "drop_call");
});

test("compact drops a call entirely when neither answer clears the threshold", async () => {
  const messages = transcript();
  const asker = new FakeAsker({ t1: { call: 0.1, result: 0.1 } });
  const result = await compact(messages, asker, { preserveRecentMessages: 1 });
  const decision = result.decisions.find((d) => d.id === "t1");
  assert.equal(decision.action, "drop_call");
  for (const message of result.messages) {
    assert.ok(!message.toolUses?.some((t) => t.tool_use_id === "toolu_1"));
    assert.ok(!message.toolResults?.some((r) => r.tool_use_id === "toolu_1"));
  }
});

test("compact never calls Jev when every tool call is pinned", async () => {
  const messages = transcript();
  const asker = new FakeAsker({});
  const result = await compact(messages, asker, { preserveRecentMessages: messages.length });
  assert.equal(asker.calls, 0);
  assert.ok(result.decisions.every((d) => d.reason === "pinned"));
});

test("a call id colliding with __proto__ or constructor cannot corrupt decisions", async () => {
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Read", input: { file_path: "a" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "z".repeat(50) }] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_2", tool: "Read", input: { file_path: "b" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_2", text: "z".repeat(50) }] },
    ...Array.from({ length: 6 }, (_, i) => ({ role: "user", text: `filler ${i}`, toolUses: [] }))
  ];
  const asker = new FakeAsker({ t1: { call: 0.9, result: 0.9 }, t2: { call: 0.1, result: 0.1 } });
  const result = await compact(messages, asker, { preserveRecentMessages: 6 });
  assert.equal(Object.getPrototypeOf({}).action, undefined);
  assert.ok(result.decisions.find((d) => d.id === "t1"));
  assert.ok(result.decisions.find((d) => d.id === "t2"));
});

test("fitState throws when the state cannot fit maxStateTokens even after every stage", () => {
  const state = {
    context: "c",
    goal: "g",
    history: Array.from({ length: 50 }, (_, i) => ({
      i,
      role: "user",
      text: "word ".repeat(2000)
    }))
  };
  assert.throws(() => fitState(state, { maxStateTokens: 10, maxRequestTokens: 20, preserveRecentMessages: 1 }), /does not fit maxStateTokens/);
});

test("fitState throws against maxStateTokens even when maxRequestTokens is generous", () => {
  // Every non-pinned message here is empty, and the 5 pinned messages still
  // exceed maxStateTokens even after the last-resort stage abridges them to
  // ~300 chars each. A check that compared against maxRequestTokens instead
  // (the bug this guards) would not throw, since the pinned content is well
  // under 30000.
  const state = {
    context: "c",
    goal: "g",
    history: [
      ...Array.from({ length: 5 }, (_, i) => ({ i, role: "user", text: "word ".repeat(300) })),
      { i: 5, role: "user", text: "" }
    ]
  };
  assert.throws(
    () => fitState(state, { maxStateTokens: 100, maxRequestTokens: 30000, preserveRecentMessages: 5 }),
    /does not fit maxStateTokens \(\d+ > 100\)/
  );
});

test("reductionRatio is 0 when there is nothing to reduce", () => {
  assert.equal(reductionRatio({ stats: { charsBefore: 0, charsAfter: 0 } }), 0);
});

test("decideCall never calls Jev for a pinned call and always keeps it", () => {
  const decision = decideCall({}, { id: "t1", tool: "Read", pinned: true }, { keepThreshold: 0.5 });
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "pinned");
});

test("applyDecisions leaves an untouched message as the same object", () => {
  const messages = transcript();
  const decisions = [
    { id: "t1", tool_use_id: "toolu_1", action: "keep", reason: "pinned" },
    { id: "t2", tool_use_id: "toolu_2", action: "keep", reason: "pinned" }
  ];
  const result = applyDecisions(messages, decisions, { truncateHeadChars: 300 });
  assert.equal(result[0], messages[0]);
});
