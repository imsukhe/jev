import { constants as fsConstants, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

// `jev mode` writes the chosen mode into the files both hosts load on their
// own -- CLAUDE.md for Claude Code, AGENTS.md for Codex -- because nothing
// else delivers it. The persisted `.jev/config.json` is never read back by a
// session, and the Claude Code hook sandbox has no filesystem access, so a
// mode set in a terminal would otherwise never reach the agent at all.
//
// Everything here stays inside the two markers. The rest of the file belongs
// to the user and is never reformatted, reordered, or rewritten.
export const BLOCK_START = "<!-- jev:start -->";
export const BLOCK_END = "<!-- jev:end -->";

export const DEFAULT_MEMORY_FILES = Object.freeze(["CLAUDE.md", "AGENTS.md"]);

/**
 * The managed block. Deliberately short: it is prepended to every session in
 * the project, so a cost-control tool that spent hundreds of tokens
 * describing itself here would be taking with one hand what it gives.
 */
export function renderModeBlock(mode, description) {
  return [
    BLOCK_START,
    "<!-- Managed by `jev mode`. Re-run `jev mode <off|lite|full|ultra>` to change it; edits inside these markers are overwritten. -->",
    `## jev mode: ${mode}`,
    "",
    description,
    "",
    "- Preserve requirements, tests, security checks, exact commands, paths, and irreversible-action warnings.",
    "- Do not claim a token or dollar saving without measured usage data.",
    "- Stop exploring once the evidence supports the requested outcome.",
    BLOCK_END
  ].join("\n");
}

function locateBlock(content, file) {
  const start = content.indexOf(BLOCK_START);
  if (start === -1) {
    if (content.includes(BLOCK_END)) {
      throw new Error(`${file} has a ${BLOCK_END} marker with no ${BLOCK_START}. Fix or remove it, then re-run.`);
    }
    return null;
  }
  const end = content.indexOf(BLOCK_END, start);
  if (end === -1) {
    throw new Error(`${file} has an unterminated ${BLOCK_START} block (no ${BLOCK_END}). Fix or remove it, then re-run.`);
  }
  return { start, end: end + BLOCK_END.length };
}

/**
 * Inserts or replaces the managed block.
 *
 * Text outside the markers is never reflowed, re-indented, or stripped --
 * not even trailing blank lines. The file belongs to the user, and
 * `jev mode off` promises to hand it back byte for byte, which is only
 * true if insertion never edited anything it did not add.
 */
export function upsertBlock(content, block, file = "file") {
  const found = locateBlock(content, file);
  if (found) return `${content.slice(0, found.start)}${block}${content.slice(found.end)}`;
  if (content.length === 0) return `${block}\n`;
  // Exactly one newline of separation, always. A variable separator cannot be
  // removed symmetrically: with two newlines there is no way to tell ours from
  // the user's, and the round trip loses a byte.
  return `${content}\n${block}\n`;
}

/**
 * Strips the managed block and exactly the separation `upsertBlock` added --
 * one blank line before it and one newline after -- so a file this module
 * wrote is restored byte for byte. Nothing else is touched.
 */
export function removeBlock(content, file = "file") {
  const found = locateBlock(content, file);
  if (!found) return content;
  let start = found.start;
  let end = found.end;
  if (content.startsWith("\n", end)) end += 1;
  if (start > 0 && content[start - 1] === "\n") start -= 1;
  return content.slice(0, start) + content.slice(end);
}

async function resolveMemoryTarget(projectDirectory, name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Invalid memoryFiles entry: ${JSON.stringify(name)}`);
  }
  if (path.isAbsolute(name)) {
    throw new Error(`memoryFiles entries must be relative to the project: ${name}`);
  }
  const target = path.resolve(projectDirectory, name);
  // Lexical containment is not enough: `linked/AGENTS.md` looks inside the
  // project while `linked` is a symlink pointing anywhere. Both the project
  // root and the target's parent are resolved through their real paths, so
  // a symlinked directory anywhere along the way is caught.
  const root = await realpath(path.resolve(projectDirectory));
  let parent;
  try {
    parent = await realpath(path.dirname(target));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`memoryFiles entry has no existing parent directory: ${name}`);
  }
  const withinRoot = parent === root || parent.startsWith(root + path.sep);
  if (!withinRoot) {
    throw new Error(`memoryFiles entry resolves outside the project directory: ${name}`);
  }
  const resolved = path.join(parent, path.basename(target));
  try {
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink()) {
      throw new Error(`${name} is a symlink; refusing to write through it. Replace it with a real file or drop it from memoryFiles.`);
    }
    if (!stats.isFile()) {
      throw new Error(`${name} is not a regular file; refusing to write to it.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return resolved;
}

/**
 * Writes with O_NOFOLLOW so the kernel refuses if the leaf became a symlink
 * between the check above and this write. Checking and then writing by path
 * leaves a window; opening with the flag closes it.
 */
async function writeNoFollow(target, contents) {
  let handle;
  try {
    handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "EMLINK") {
      throw new Error(`${path.basename(target)} became a symlink; refusing to write through it.`);
    }
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

export async function applyModeMemory(projectDirectory, mode, options = {}) {
  const files = options.files ?? DEFAULT_MEMORY_FILES;
  const description = options.description ?? "";
  const create = options.create ?? true;
  const changed = [];

  for (const name of files) {
    const target = await resolveMemoryTarget(projectDirectory, name);
    let existing = "";
    let exists = true;
    try {
      existing = await readFile(target, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      exists = false;
    }

    // Removing from a file that never existed, or creating one we were told
    // not to create, are both no-ops rather than errors.
    if (!exists && (mode === "off" || !create)) continue;

    const next =
      mode === "off" ? removeBlock(existing, name) : upsertBlock(existing, renderModeBlock(mode, description), name);
    if (exists && next === existing) continue;
    await writeNoFollow(target, next);
    changed.push(name);
  }
  return changed;
}
