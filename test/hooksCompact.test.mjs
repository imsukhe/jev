import assert from "node:assert/strict";
import test from "node:test";
import { register, resolveHookConfig } from "../hooks/compact.mjs";

// These tests exercise the hook's pure logic and fallback behavior with a
// fake `on`/`$` harness modeled on the reference engine interface. They do
// NOT prove the hook registers correctly against a real Claude Code
// install -- that is explicitly unverified (see the file header comment in
// hooks/compact.mjs and adapters/claude/README.md).

function fakeEngine({ fetchImpl, env = {}, clockMs = null } = {}) {
  const logs = [];
  return {
    logs,
    $: {
      http: { fetch: fetchImpl },
      env: { get: async (name) => env[name] },
      settings: { read: async () => ({}) },
      ui: { log: (text) => logs.push(text), toast: () => {} },
      // Never settles by default, so a responsive fetch always wins the race.
      clock: { after: (ms) => (clockMs === null ? new Promise(() => {}) : new Promise((r) => setTimeout(r, clockMs))) },
      session: { usage: async () => ({ context: { percent: 0 } }), compact: async () => {} }
    }
  };
}

function registerHandlers(options) {
  const handlers = {};
  register((event, handler) => (handlers[event] = handler), options);
  return handlers;
}

test("resolveHookConfig fills defaults and only takes recognized keys", () => {
  const config = resolveHookConfig({ keepThreshold: 0.7, apiKey: "k", unrelated: "ignored" });
  assert.equal(config.enabled, false, "enabled defaults to false unless explicitly set true");
  assert.equal(config.keepThreshold, 0.7);
  assert.equal(config.preserveRecentMessages, 6);
  assert.equal(config.apiKey, "k");
  assert.equal(config.model, "jev-latest");
});

test("resolveHookConfig only turns enabled on for a literal true", () => {
  assert.equal(resolveHookConfig({ enabled: true }).enabled, true);
  assert.equal(resolveHookConfig({ enabled: "true" }).enabled, false);
  assert.equal(resolveHookConfig({}).enabled, false);
});

test("session.compact is a no-op when the hook's own enabled option is false, its default", async () => {
  const handlers = registerHandlers({ apiKey: "test-key" });
  let fetchCalled = false;
  const { $ } = fakeEngine({ fetchImpl: async () => ((fetchCalled = true), { status: 200, ok: true, text: "{}" }) });
  let fellThrough = false;
  const messages = [{ role: "user", text: "go", toolUses: [] }];
  const outcome = await handlers["session.compact"]($, { messages }, (event) => {
    fellThrough = true;
    return event;
  });
  assert.ok(fellThrough, "disabled by default: falls straight through to next()");
  assert.ok(!fetchCalled, "never attempts a Jev call while disabled");
  assert.deepEqual(outcome, { messages });
});

test("turn.complete is a no-op when disabled, even above compactAtPercent", async () => {
  const handlers = registerHandlers({ compactAtPercent: 60 });
  let compactCalled = false;
  let usageCalled = false;
  const $high = {
    session: {
      usage: async () => ((usageCalled = true), { context: { percent: 80 } }),
      compact: async () => (compactCalled = true)
    },
    ui: { log: () => {} }
  };
  let fellThrough = false;
  await handlers["turn.complete"]($high, {}, () => (fellThrough = true));
  assert.ok(fellThrough);
  assert.ok(!compactCalled);
  assert.ok(!usageCalled, "disabled: does not even check context usage");
});

test("session.compact returns compacted messages when reduction clears the minimum ratio", async () => {
  const handlers = registerHandlers({ enabled: true, minReductionRatio: 0, apiKey: "test-key" });
  const { $, logs } = fakeEngine({
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      text: JSON.stringify({ answers: { "t1:call": { noul: 0.9 }, "t1:result": { noul: 0.9 } } })
    })
  });
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Read", input: { file_path: "a" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "z".repeat(50) }] },
    ...Array.from({ length: 6 }, (_, i) => ({ role: "user", text: `filler ${i}`, toolUses: [] }))
  ];
  let fellThrough = false;
  const outcome = await handlers["session.compact"]($, { messages }, () => (fellThrough = true));
  assert.ok(!fellThrough);
  assert.ok(outcome.messages);
  assert.ok(logs.some((line) => line.includes("kept")));
});

test("session.compact falls through to next() when the API key is missing", async () => {
  const handlers = registerHandlers({ enabled: true });
  const { $, logs } = fakeEngine({ fetchImpl: async () => ({ status: 200, ok: true, text: "{}" }) });
  let fellThrough = false;
  const outcome = await handlers["session.compact"]($, { messages: [] }, (event) => {
    fellThrough = true;
    return event;
  });
  assert.ok(fellThrough);
  assert.deepEqual(outcome, { messages: [] });
  assert.ok(logs.some((line) => line.includes("TYPESAFE_API_KEY")));
});

test("session.compact falls through to next() when Jev's response is malformed", async () => {
  const handlers = registerHandlers({ enabled: true, apiKey: "k" });
  const { $, logs } = fakeEngine({ fetchImpl: async () => ({ status: 500, ok: false, text: "boom" }) });
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Read", input: {} }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "x".repeat(50) }] },
    ...Array.from({ length: 6 }, (_, i) => ({ role: "user", text: `filler ${i}`, toolUses: [] }))
  ];
  let fellThrough = false;
  await handlers["session.compact"]($, { messages }, () => (fellThrough = true));
  assert.ok(fellThrough);
  assert.ok(logs.some((line) => line.includes("fallback to built-in summary")));
});

test("a hung request hits the deadline and falls back instead of hanging forever", async () => {
  // The hook's whole promise is that it degrades to the built-in summary.
  // Without a deadline a stalled fetch never settles and that never happens.
  const handlers = registerHandlers({ enabled: true, apiKey: "k", requestTimeoutMs: 5 });
  const { $, logs } = fakeEngine({ fetchImpl: () => new Promise(() => {}), clockMs: 1 });
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Read", input: {} }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "x".repeat(50) }] },
    ...Array.from({ length: 6 }, (_, i) => ({ role: "user", text: `filler ${i}`, toolUses: [] }))
  ];
  let fellThrough = false;
  await handlers["session.compact"]($, { messages }, () => (fellThrough = true));
  assert.ok(fellThrough, "the fallback ran");
  assert.ok(logs.some((l) => /timed out/.test(l)), `expected a timeout log, got: ${logs.join(" | ")}`);
});

test("turn.complete requests compaction only once context.percent reaches compactAtPercent", async () => {
  const handlers = registerHandlers({ enabled: true, compactAtPercent: 60 });
  let compactCalled = false;
  const $low = {
    session: { usage: async () => ({ context: { percent: 10 } }), compact: async () => (compactCalled = true) },
    ui: { log: () => {} }
  };
  await handlers["turn.complete"]($low, {}, () => {});
  assert.ok(!compactCalled, "below threshold, should not compact");

  const $high = {
    session: { usage: async () => ({ context: { percent: 80 } }), compact: async () => (compactCalled = true) },
    ui: { log: () => {} }
  };
  await handlers["turn.complete"]($high, {}, () => {});
  assert.ok(compactCalled, "above threshold, should request compaction");
});
