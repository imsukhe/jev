import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyModeMemory, removeBlock, renderModeBlock, upsertBlock } from "../lib/modeMemory.mjs";

const BLOCK = renderModeBlock("full", "Use targeted context.");

test("upsertBlock appends to a file that has none, keeping the original content", () => {
  const out = upsertBlock("# Project\n\nMy rules.\n", BLOCK);
  assert.match(out, /^# Project\n\nMy rules\.\n\n<!-- jev:start -->/);
  assert.ok(out.endsWith("<!-- jev:end -->\n"));
});

test("upsertBlock replaces in place, preserving content on both sides", () => {
  const before = `# Top\n\n${renderModeBlock("lite", "old")}\n\n## Mine\n\nKeep me.\n`;
  const out = upsertBlock(before, BLOCK);
  assert.match(out, /# Top/);
  assert.match(out, /## Mine\n\nKeep me\./);
  assert.match(out, /jev mode: full/);
  assert.ok(!out.includes("jev mode: lite"));
  assert.equal(out.match(/jev:start/g).length, 1, "never duplicates the block");
});

test("upsertBlock is idempotent", () => {
  const once = upsertBlock("# Project\n", BLOCK);
  assert.equal(upsertBlock(once, BLOCK), once);
});

test("removeBlock strips the block and collapses the gap it leaves", () => {
  const before = `# Top\n\n${BLOCK}\n\n## Mine\n\nKeep me.\n`;
  const out = removeBlock(before);
  assert.equal(out, "# Top\n\n## Mine\n\nKeep me.\n");
});

test("removeBlock empties a file that held nothing else", () => {
  assert.equal(removeBlock(`${BLOCK}\n`), "");
});

test("removeBlock leaves a file without a block untouched", () => {
  const content = "# Just mine\n";
  assert.equal(removeBlock(content), content);
});

test("a malformed block is refused rather than guessed at", () => {
  // Rewriting around a half-written marker risks eating the user's file.
  assert.throws(() => upsertBlock("# X\n<!-- jev:start -->\nbroken\n", BLOCK, "CLAUDE.md"), /unterminated/);
  assert.throws(() => upsertBlock("# X\n<!-- jev:end -->\n", BLOCK, "CLAUDE.md"), /with no <!-- jev:start -->/);
});

test("applyModeMemory writes, updates, and removes across both host files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-mem-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "CLAUDE.md"), "# Mine\n\nHouse rules.\n", "utf8");

  const files = ["CLAUDE.md", "AGENTS.md"];
  let changed = await applyModeMemory(dir, "full", { files, description: "Use targeted context." });
  assert.deepEqual(changed, ["CLAUDE.md", "AGENTS.md"], "creates the missing one, updates the existing one");
  const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
  assert.match(claude, /House rules\./, "the user's own content survives");
  assert.match(claude, /jev mode: full/);

  // Re-running the same mode must not touch the files at all.
  changed = await applyModeMemory(dir, "full", { files, description: "Use targeted context." });
  assert.deepEqual(changed, [], "no write when nothing would change");

  changed = await applyModeMemory(dir, "ultra", { files, description: "Smallest adequate path." });
  assert.deepEqual(changed, ["CLAUDE.md", "AGENTS.md"]);
  assert.match(await readFile(path.join(dir, "AGENTS.md"), "utf8"), /jev mode: ultra/);

  changed = await applyModeMemory(dir, "off", { files });
  assert.deepEqual(changed, ["CLAUDE.md", "AGENTS.md"]);
  const afterOff = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
  assert.equal(afterOff, "# Mine\n\nHouse rules.\n", "back to exactly what the user had");
});

test("a memoryFiles entry cannot escape the project or follow a symlink", async (t) => {
  // memoryFiles comes from .jev/config.json, which ships with a cloned repo.
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-mem-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outside = path.join(dir, "outside.md");
  await writeFile(outside, "SECRET\n", "utf8");
  const project = path.join(dir, "project");
  await mkdir(project, { recursive: true });
  await symlink(outside, path.join(project, "AGENTS.md"));

  // A symlinked *directory* passes lexical containment and a leaf lstat:
  // `linked/AGENTS.md` looks local while `linked` points anywhere.
  await symlink(path.join(dir, "elsewhere"), path.join(project, "linked"));
  await mkdir(path.join(dir, "elsewhere"), { recursive: true });
  await writeFile(path.join(dir, "elsewhere", "AGENTS.md"), "ALSO SECRET\n", "utf8");

  for (const bad of ["../outside.md", path.join(dir, "outside.md"), "AGENTS.md", "linked/AGENTS.md"]) {
    await assert.rejects(
      () => applyModeMemory(project, "full", { files: [bad], description: "d" }),
      /resolves outside|must be relative|symlink/,
      `refused: ${bad}`
    );
  }
  assert.equal(await readFile(outside, "utf8"), "SECRET\n", "the file outside the project is untouched");
  assert.equal(
    await readFile(path.join(dir, "elsewhere", "AGENTS.md"), "utf8"),
    "ALSO SECRET\n",
    "nothing was written through the symlinked directory"
  );
});

test("inserting and removing the block restores the file byte for byte", () => {
  // `jev mode off` promises the file back exactly as it was, which is only
  // true if insertion never touched whitespace it did not add.
  for (const original of [
    "# Mine\n\n\ntrailing blanks\n\n\n",
    "no newline at eof",
    "",
    "# A\n",
    "   \n\nweird   \n\t\n",
    "# X\n\n## Y\n\nbody\n"
  ]) {
    const restored = removeBlock(upsertBlock(original, BLOCK));
    assert.equal(restored, original, `round trip changed ${JSON.stringify(original)}`);
  }
});

test("applyModeMemory does not create files just to remove a block from them", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-mem-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const changed = await applyModeMemory(dir, "off", { files: ["CLAUDE.md"] });
  assert.deepEqual(changed, []);
  await assert.rejects(() => readFile(path.join(dir, "CLAUDE.md"), "utf8"), /ENOENT/);
});

test("applyModeMemory honours create:false for files that do not exist yet", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-mem-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const changed = await applyModeMemory(dir, "full", { files: ["CLAUDE.md"], description: "d", create: false });
  assert.deepEqual(changed, []);
});
