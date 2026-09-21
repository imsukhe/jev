import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";

const cli = path.resolve("bin/jev.mjs");
const transcriptFixture = path.resolve("examples/transcript.json");

// A fake Jev server lives in this same process, so the CLI child must be run
// with async spawn: spawnSync blocks this process's event loop, which would
// stop the fake server from ever answering the child's request (deadlock).
function runAsync(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function startFakeJevServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { questions } = JSON.parse(body);
        const answers = {};
        for (const name of Object.keys(questions)) answers[name] = { noul: 0.9 };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers, usage: { input_tokens: 42, output_tokens: 7 } }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("jev compact runs against a fake Jev server and records usage to the ledger", async (t) => {
  const server = await startFakeJevServer();
  t.after(() => server.close());
  const { port } = server.address();

  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  spawnSync(process.execPath, [cli, "compaction", "on"], { cwd: directory, encoding: "utf8" });

  const env = { ...process.env, TYPESAFE_API_KEY: "test-key" };
  const result = await runAsync(
    directory,
    ["compact", transcriptFixture, "--base-url", `http://127.0.0.1:${port}/v1/systemone`, "--json"],
    env
  );
  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decisions.length, 2);
  assert.ok(parsed.decisions.every((d) => d.action === "keep"));

  const report = JSON.parse(spawnSync(process.execPath, [cli, "report", "--json"], { cwd: directory, encoding: "utf8" }).stdout);
  assert.equal(report.byHost.jev.totalTokens, 49);
});

test("jev compact refuses to run when compaction is off", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, "compact", transcriptFixture], { cwd: directory, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Compaction is off/);
});

test("jev compact fails clearly with no API key configured, once compaction is on", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  spawnSync(process.execPath, [cli, "compaction", "on"], { cwd: directory, encoding: "utf8" });

  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const result = spawnSync(process.execPath, [cli, "compact", transcriptFixture], { cwd: directory, encoding: "utf8", env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TYPESAFE_API_KEY is not configured/);
});

test("jev mode off is an absolute kill switch: disables compaction and blocks jev compact", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  spawnSync(process.execPath, [cli, "compaction", "on"], { cwd: directory, encoding: "utf8" });
  const modeOff = spawnSync(process.execPath, [cli, "mode", "off"], { cwd: directory, encoding: "utf8" });
  assert.equal(modeOff.status, 0, modeOff.stderr);
  assert.match(modeOff.stdout, /Compaction disabled/);

  const status = JSON.parse(spawnSync(process.execPath, [cli, "status", "--json"], { cwd: directory, encoding: "utf8" }).stdout);
  assert.equal(status.compaction.enabled, false);

  const compactResult = spawnSync(process.execPath, [cli, "compact", transcriptFixture], { cwd: directory, encoding: "utf8" });
  assert.notEqual(compactResult.status, 0);
  assert.match(compactResult.stderr, /mode is "off"/);

  const enableResult = spawnSync(process.execPath, [cli, "compaction", "on"], { cwd: directory, encoding: "utf8" });
  assert.notEqual(enableResult.status, 0);
  assert.match(enableResult.stderr, /mode is "off"/);
});

test("jev compact requires a transcript path", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, "compact"], { cwd: directory, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a transcript/);
});

test("jev compaction on/off persists backend and model choice", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  spawnSync(process.execPath, [cli, "init", "--mode", "full"], { cwd: directory, encoding: "utf8" });
  const on = spawnSync(process.execPath, [cli, "compaction", "on", "--backend", "vercel-gateway", "--model", "typesafe-ai/jev"], {
    cwd: directory,
    encoding: "utf8"
  });
  assert.equal(on.status, 0, on.stderr);

  const status = JSON.parse(spawnSync(process.execPath, [cli, "status", "--json"], { cwd: directory, encoding: "utf8" }).stdout);
  assert.equal(status.compaction.enabled, true);
  assert.equal(status.compaction.backend, "vercel-gateway");
  assert.equal(status.compaction.model, "typesafe-ai/jev");
});

test("switching backend resets the model to that backend's own name", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  spawnSync(process.execPath, [cli, "compaction", "on", "--backend", "vercel-gateway"], { cwd: directory, encoding: "utf8" });
  let status = JSON.parse(spawnSync(process.execPath, [cli, "status", "--json"], { cwd: directory, encoding: "utf8" }).stdout);
  assert.equal(status.compaction.model, "typesafe-ai/jev", "gateway uses the catalog id");

  // TypeSafe's own API rejects the gateway's catalog id, so switching back
  // must not leave the gateway model name behind.
  spawnSync(process.execPath, [cli, "compaction", "on", "--backend", "typesafe"], { cwd: directory, encoding: "utf8" });
  status = JSON.parse(spawnSync(process.execPath, [cli, "status", "--json"], { cwd: directory, encoding: "utf8" }).stdout);
  assert.equal(status.compaction.model, "jev-latest", "direct backend uses TypeSafe's own model name");

  // An explicit --model still wins over the backend default.
  spawnSync(process.execPath, [cli, "compaction", "on", "--backend", "vercel-gateway", "--model", "pinned-model"], { cwd: directory, encoding: "utf8" });
  status = JSON.parse(spawnSync(process.execPath, [cli, "status", "--json"], { cwd: directory, encoding: "utf8" }).stdout);
  assert.equal(status.compaction.model, "pinned-model");
});

test("jev compaction rejects an unknown backend", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  spawnSync(process.execPath, [cli, "init"], { cwd: directory, encoding: "utf8" });
  const result = spawnSync(process.execPath, [cli, "compaction", "on", "--backend", "openai-direct"], { cwd: directory, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown compaction backend/);
});
