import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const requiredFiles = [
  "plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "skills/jev/SKILL.md",
  "skills/jev-audit/SKILL.md",
  "bin/jev.mjs"
];

for (const relativePath of requiredFiles) {
  await access(path.join(root, relativePath));
}

const manifestPaths = ["plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"];
let sharedRepository;
for (const relativePath of manifestPaths) {
  const manifest = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  if (manifest.name !== "jev") throw new Error(`${relativePath} must use name jev.`);
  if (!manifest.description) throw new Error(`${relativePath} must have a description.`);
  if (!manifest.repository) throw new Error(`${relativePath} must have a repository.`);
  sharedRepository ??= manifest.repository;
  if (manifest.repository !== sharedRepository) {
    throw new Error(`${relativePath} repository must match the other manifests: ${sharedRepository}.`);
  }
}

for (const relativePath of ["skills/jev/SKILL.md", "skills/jev-audit/SKILL.md"]) {
  const skill = await readFile(path.join(root, relativePath), "utf8");
  if (!skill.startsWith("---\nname:")) throw new Error(`${relativePath} requires front matter with a name.`);
  if (!skill.includes("description:")) throw new Error(`${relativePath} requires a description.`);
}

console.log("jev manifests and skills are valid.");
