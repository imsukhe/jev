import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { answerConfidence, buildClassifyRequest, classifyWithAsker, decideMode } from "../lib/classify.mjs";

const cli = path.resolve("bin/jev.mjs");

test("the classify question offers every mode a meaning, not just a name", () => {
  const { state, questions } = buildClassifyRequest("fix the typo");
  assert.equal(state.request, "fix the typo");
  assert.match(state.context, /not the tone or urgency/, "tone is what the model follows without being told otherwise");
  const question = questions.mode;
  assert.equal(question.type, "choice");
  for (const mode of ["ultra", "lite", "full"]) {
    assert.ok(question.criteria[mode]?.length > 20, `${mode} is described`);
  }
});

test("answerConfidence reads confidence or the winning probability", () => {
  assert.equal(answerConfidence({ confidence: 0.9 }), 0.9);
  assert.equal(answerConfidence({ probabilities: { ultra: 0.7, full: 0.3 } }), 0.7);
  assert.equal(answerConfidence({}), 0);
});

test("a confident downgrade is taken", () => {
  const d = decideMode({ choice: "ultra", probabilities: { ultra: 0.97, full: 0.03 } }, { minConfidence: 0.85 });
  assert.equal(d.mode, "ultra");
  assert.equal(d.reason, "chosen");
});

test("a low-confidence downgrade is refused in favour of the careful mode", () => {
  // The live failure this guards: "tiny fix: change the auth check from ===
  // to ==" came back `ultra` at 0.60, where correct answers scored 0.93+.
  const d = decideMode({ choice: "ultra", probabilities: { ultra: 0.6, full: 0.4 } }, { minConfidence: 0.85 });
  assert.equal(d.mode, "full", "never cheapen effort on a shaky answer");
  assert.equal(d.reason, "low-confidence");
  assert.equal(d.suggested, "ultra", "what it wanted is still reported");
});

test("choosing the careful mode needs no confidence at all", () => {
  const d = decideMode({ choice: "full", probabilities: { full: 0.4, ultra: 0.35 } }, { minConfidence: 0.85 });
  assert.equal(d.mode, "full");
  assert.equal(d.reason, "chosen", "full is the fallback already, so there is nothing to guard against");
});

test("an unrecognized or missing choice falls back rather than throwing", () => {
  assert.equal(decideMode({ choice: "turbo", probabilities: { turbo: 0.99 } }).mode, "full");
  assert.equal(decideMode({ choice: "turbo", probabilities: { turbo: 0.99 } }).reason, "unrecognized-choice");
  assert.equal(decideMode(undefined).mode, "full");
  assert.equal(decideMode(null).reason, "unrecognized-choice");
});

test("classifyWithAsker passes the prompt through and applies the guard", async () => {
  let seenState;
  const asker = {
    async ask(state) {
      seenState = state;
      return { answers: { mode: { choice: "ultra", probabilities: { ultra: 0.5, full: 0.5 } } } };
    }
  };
  const result = await classifyWithAsker("drop the users table", asker, { minConfidence: 0.85 });
  assert.equal(seenState.request, "drop the users table");
  assert.equal(result.mode, "full");
  assert.equal(result.suggested, "ultra");
});

function startStub(choice, confidence) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            answers: { mode: { type: "choice", choice, probabilities: { [choice]: confidence } } },
            usage: { input_tokens: 120, output_tokens: 8 }
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runAsync(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("jev classify --apply sets the mode and records what the call cost", async (t) => {
  const server = await startStub("ultra", 0.97);
  t.after(() => server.close());
  const { port } = server.address();
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  spawnSync(process.execPath, [cli, "init", "--mode", "full", "--no-memory"], { cwd: directory, encoding: "utf8" });
  const env = { ...process.env, TYPESAFE_API_KEY: "stub-key" };
  const result = await runAsync(
    directory,
    ["classify", "fix the typo in README", "--apply", "--no-memory", "--base-url", `http://127.0.0.1:${port}/v1/systemone`],
    env
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mode: ultra/);

  const status = JSON.parse(
    spawnSync(process.execPath, [cli, "status", "--json"], { cwd: directory, encoding: "utf8" }).stdout
  );
  assert.equal(status.mode, "ultra", "--apply persisted it");

  const report = JSON.parse(
    spawnSync(process.execPath, [cli, "report", "--json"], { cwd: directory, encoding: "utf8" }).stdout
  );
  assert.equal(report.byHost.jev.totalTokens, 128, "classification cost lands in the ledger too");
});

test("a --backend override brings that backend's model with it", async (t) => {
  // Otherwise the gateway is sent `jev-latest`, or TypeSafe is sent
  // `typesafe-ai/jev`, and the provider rejects the call.
  let seenModel;
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seenModel = JSON.parse(body).model;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers: { mode: { type: "choice", choice: "full", probabilities: { full: 0.9 } } } }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Configured for the gateway (model typesafe-ai/jev), overridden to direct.
  spawnSync(process.execPath, [cli, "init", "--mode", "full", "--no-memory"], { cwd: directory, encoding: "utf8" });
  spawnSync(process.execPath, [cli, "compaction", "on", "--backend", "vercel-gateway"], { cwd: directory, encoding: "utf8" });

  const env = { ...process.env, TYPESAFE_API_KEY: "stub" };
  const result = await runAsync(
    directory,
    ["classify", "anything", "--backend", "typesafe", "--base-url", `http://127.0.0.1:${server.address().port}/v1/systemone`],
    env
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(seenModel, "jev-latest", "the direct backend's own model was sent, not the gateway's");
});

test("jev classify refuses to run while mode is off", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  spawnSync(process.execPath, [cli, "init", "--mode", "off", "--no-memory"], { cwd: directory, encoding: "utf8" });
  const result = spawnSync(process.execPath, [cli, "classify", "anything"], { cwd: directory, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mode is "off"/);
});
