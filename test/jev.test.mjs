import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const cli = path.resolve("bin/jev.mjs");

function run(cwd, ...argumentsList) {
  const result = spawnSync(process.execPath, [cli, ...argumentsList], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("initializes a mode, records usage, and reports totals", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.match(run(directory, "init", "--mode", "lite"), /lite mode/);
  assert.match(run(directory, "mode", "ultra"), /set to ultra/);
  const status = JSON.parse(run(directory, "status", "--json"));
  assert.equal(status.mode, "ultra");

  run(directory, "record", "--host", "claude", "--model", "claude-test", "--input", "100", "--output", "25", "--cost", "0.0125");
  run(directory, "record", "--host", "codex", "--model", "gpt-test", "--input", "50", "--cache-read", "20");
  const report = JSON.parse(run(directory, "report", "--json"));
  assert.equal(report.sessions, 2);
  assert.equal(report.totalTokens, 195);
  assert.equal(report.costUsd, 0.0125);
  assert.equal(report.byHost.claude.totalTokens, 125);
  assert.equal(report.byHost.codex.totalTokens, 70);
});

test("rejects invalid modes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, "mode", "maximum"], { cwd: directory, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown mode/);
});

test("refuses to re-init over an existing config without --force", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  run(directory, "init", "--mode", "lite");
  run(directory, "compaction", "on", "--model", "jev-pinned");

  const result = spawnSync(process.execPath, [cli, "init", "--mode", "full"], { cwd: directory, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/);

  const status = JSON.parse(run(directory, "status", "--json"));
  assert.equal(status.mode, "lite");
  assert.equal(status.compaction.enabled, true, "an existing config's compaction settings survive a refused re-init");
  assert.equal(status.compaction.model, "jev-pinned");
});

test("jev init --force resets an existing config", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  run(directory, "init", "--mode", "lite");
  run(directory, "compaction", "on", "--model", "jev-pinned");

  assert.match(run(directory, "init", "--mode", "full", "--force"), /Reset .* full mode/);
  const status = JSON.parse(run(directory, "status", "--json"));
  assert.equal(status.mode, "full");
  assert.equal(status.compaction.enabled, false);
  assert.equal(status.compaction.model, "jev-latest");
});

test("jev mode delivers the mode to the host memory files, and --no-memory opts out", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.match(run(directory, "init", "--mode", "full"), /Wrote the mode into CLAUDE\.md, AGENTS\.md/);
  const claude = await readFile(path.join(directory, "CLAUDE.md"), "utf8");
  assert.match(claude, /jev mode: full/);

  // --no-memory must leave the files exactly as they were.
  const before = await readFile(path.join(directory, "CLAUDE.md"), "utf8");
  const output = run(directory, "mode", "lite", "--no-memory");
  assert.ok(!/Wrote the mode into/.test(output));
  assert.equal(await readFile(path.join(directory, "CLAUDE.md"), "utf8"), before, "untouched");
  assert.equal(JSON.parse(run(directory, "status", "--json")).mode, "lite", "config still records the mode");

  assert.match(run(directory, "mode", "off"), /Removed the jev block from/);
  assert.ok(!(await readFile(path.join(directory, "CLAUDE.md"), "utf8")).includes("jev:start"));
});

test("an empty memoryFiles list opts out of delivery entirely", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await mkdir(path.join(directory, ".jev"), { recursive: true });
  await writeFile(
    path.join(directory, ".jev", "config.json"),
    JSON.stringify({ schemaVersion: 1, mode: "full", memoryFiles: [] }),
    "utf8"
  );
  const output = run(directory, "mode", "ultra");
  assert.ok(!/Wrote the mode into/.test(output));
  await assert.rejects(() => readFile(path.join(directory, "CLAUDE.md"), "utf8"), /ENOENT/);
});

test("an untrusted config cannot raise the cost ceilings", async (t) => {
  // .jev/config.json ships with a cloned repo, so its numbers are input, not
  // preference: unclamped, a repo could set maxRequests to 100000.
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, ".jev"), { recursive: true });
  await writeFile(
    path.join(directory, ".jev", "config.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "full",
      compaction: { maxRequests: 100000, maxConcurrentRequests: 5000, requestTimeoutMs: -5, keepThreshold: "high" },
      memoryFiles: "not-an-array"
    }),
    "utf8"
  );
  const status = JSON.parse(run(directory, "status", "--json"));
  assert.equal(status.compaction.maxRequests, 64, "clamped to the ceiling");
  assert.equal(status.compaction.maxConcurrentRequests, 16);
  assert.equal(status.compaction.requestTimeoutMs, 1000, "raised to the floor");
  assert.equal(status.compaction.maxGoalChars, 2000, "an unset limit takes the default");
  assert.equal(status.compaction.keepThreshold, 0.5, "non-numeric falls back to the default");
  assert.deepEqual(status.memoryFiles, ["CLAUDE.md", "AGENTS.md"], "a non-array memoryFiles is ignored");
});

test("one torn ledger line does not brick the report", async (t) => {
  // A process killed mid-append leaves a partial line. Failing the whole
  // read on it left an append-only log nobody could read, repairable only
  // by hand-editing .jev/usage.jsonl.
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  run(directory, "init", "--mode", "full", "--no-memory");
  run(directory, "record", "--host", "claude", "--model", "m", "--input", "10");
  await writeFile(path.join(directory, ".jev", "usage.jsonl"), '{"host":"claude","model":"m","inputTok', { flag: "a" });
  await writeFile(path.join(directory, ".jev", "usage.jsonl"), '\n{"host":"claude","model":"m","inputTokens":5}\n', { flag: "a" });

  const result = spawnSync(process.execPath, [cli, "report", "--json"], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.totalTokens, 15, "both readable records still counted");
  assert.deepEqual(report.skippedLines, [2], "the damaged line is named, not hidden");
  assert.match(
    spawnSync(process.execPath, [cli, "report"], { cwd: directory, encoding: "utf8" }).stderr,
    /skipped 1 unreadable line/
  );
});

test("jev compact rejects a transcript that is not an array of messages", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  run(directory, "init", "--mode", "full", "--no-memory");
  run(directory, "compaction", "on");
  await writeFile(path.join(directory, "t.json"), JSON.stringify({ messages: [] }), "utf8");

  const result = spawnSync(process.execPath, [cli, "compact", "t.json"], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, TYPESAFE_API_KEY: "stub" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain a JSON array of messages/);
  assert.doesNotMatch(result.stderr, /is not a function/, "no internal name leaks into the message");
});

test("a host or model named __proto__ does not corrupt the report aggregates", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  run(directory, "init", "--mode", "full");
  run(directory, "record", "--host", "__proto__", "--model", "constructor", "--input", "10");
  run(directory, "record", "--host", "claude", "--model", "claude-test", "--input", "5");

  const report = JSON.parse(run(directory, "report", "--json"));
  assert.equal(report.sessions, 2);
  assert.equal(report.byHost.__proto__.totalTokens, 10);
  assert.equal(report.byHost.claude.totalTokens, 5);
  assert.equal(Object.keys(report.byHost).length, 2);
  assert.equal(Object.getPrototypeOf({}).sessions, undefined);
});

test("fills in missing config fields from defaults instead of dropping them", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await mkdir(path.join(directory, ".jev"), { recursive: true });
  await writeFile(
    path.join(directory, ".jev", "config.json"),
    JSON.stringify({ schemaVersion: 1, mode: "full", limits: { toolOutputChars: 5000 } }),
    "utf8"
  );

  const status = JSON.parse(run(directory, "status", "--json"));
  assert.equal(status.limits.toolOutputChars, 5000);
  assert.equal(status.limits.parallelTasks, 1);
  assert.equal(status.compaction.enabled, false);
  assert.equal(status.compaction.backend, "typesafe");

});
