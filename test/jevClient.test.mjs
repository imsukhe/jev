import assert from "node:assert/strict";
import test from "node:test";
import { TypeSafeJevClient } from "../lib/jevClient.mjs";
import { buildJevRequest, noulAnswer, parseJevResponse } from "../lib/jevProtocol.mjs";

test("buildJevRequest posts model, state, and questions with a bearer header", () => {
  const request = buildJevRequest({ apiKey: "key-123", model: "jev-latest" }, "state", { q1: { type: "noul" } });
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, "Bearer key-123");
  assert.deepEqual(JSON.parse(request.body), { model: "jev-latest", state: "state", questions: { q1: { type: "noul" } } });
});

test("buildJevRequest defaults to the System One URL and jev-latest model", () => {
  const request = buildJevRequest({ apiKey: "k" }, "s", {});
  assert.equal(request.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(JSON.parse(request.body).model, "jev-latest");
});

test("parseJevResponse throws on a non-ok status", () => {
  assert.throws(() => parseJevResponse(500, false, "server error"), /Jev request failed \(500\)/);
});

test("parseJevResponse throws on malformed JSON", () => {
  assert.throws(() => parseJevResponse(200, true, "not json"), /malformed JSON/);
});

test("parseJevResponse throws when answers is missing", () => {
  assert.throws(() => parseJevResponse(200, true, JSON.stringify({ model: "jev-latest" })), /missing answers/);
});

test("noulAnswer reads a valid probability and rejects a missing one", () => {
  assert.equal(noulAnswer({ t1: { noul: 0.7 } }, "t1"), 0.7);
  assert.throws(() => noulAnswer({}, "t1"), /Invalid Jev answer/);
});

test("TypeSafeJevClient.ask sends the request through an injected fetch and parses the response", async () => {
  let capturedUrl;
  let capturedInit;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { status: 200, ok: true, text: async () => JSON.stringify({ answers: { t1: { noul: 0.8 } } }) };
  };
  const client = new TypeSafeJevClient({ apiKey: "test-key", fetch: fakeFetch });
  const response = await client.ask("state", { t1: { type: "noul" } });
  assert.equal(capturedUrl, "https://api.typesafe.ai/v1/systemone");
  assert.equal(capturedInit.headers.authorization, "Bearer test-key");
  assert.equal(response.answers.t1.noul, 0.8);
});

test("TypeSafeJevClient.ask throws when no API key is configured", async () => {
  const original = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const client = new TypeSafeJevClient({ fetch: async () => ({ status: 200, ok: true, text: async () => "{}" }) });
    await assert.rejects(() => client.ask("state", {}), /TYPESAFE_API_KEY is not configured/);
  } finally {
    if (original !== undefined) process.env.TYPESAFE_API_KEY = original;
  }
});
