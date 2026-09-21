#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  COMPACTION_BACKENDS,
  MODES,
  assertCompactionBackend,
  assertMode,
  configPath,
  defaultConfig,
  loadConfig,
  saveConfig
} from "../lib/config.mjs";
import { appendRecord, readRecords, summarizeRecords } from "../lib/ledger.mjs";
import { summarize } from "../lib/compaction.mjs";
import { applyModeMemory } from "../lib/modeMemory.mjs";
import { compactMessages } from "../lib/compactMessages.mjs";
import { classifyPrompt } from "../lib/classifyPrompt.mjs";

const HELP = `jev: a wrapper that gets more value out of TypeSafe's JEV model

Usage:
  jev init [--mode full] [--force] [--no-memory]
  jev mode <off|lite|full|ultra> [--no-memory]
  jev status [--json]
  jev record --host <claude|codex> --model <name> [--input N] [--output N]
             [--cache-read N] [--cache-write N] [--cost USD] [--task text]
  jev report [--json]
  jev classify "<prompt>" [--apply] [--json] [--backend ...] [--base-url url]
  jev compaction <on|off> [--backend typesafe|vercel-gateway] [--model name]
  jev compact <transcript.json> [--backend typesafe|vercel-gateway]
              [--model name] [--base-url url] [--json]

Project state stays in .jev/. Setting a mode also writes a managed block
into CLAUDE.md and AGENTS.md, which the hosts load on their own; pass
--no-memory to skip that, or empty memoryFiles in .jev/config.json.
Modes, the ledger and reports are local and need no key; "jev compact"
calls TypeSafe's JEV model and needs one.
"jev mode off" disables compaction too: the one command that guarantees
no JEV calls. This is a wrapper around JEV, not a replacement for it, and
is not affiliated with TypeSafe AI or Vercel. See README.md.`;

function options(argumentsList) {
  const result = { _: [] };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "json" || key === "force" || key === "no-memory" || key === "apply") {
      result[key] = true;
      continue;
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Option --${key} requires a value.`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function renderStatus(config, projectDirectory) {
  return [
    `Mode: ${config.mode}`,
    `Policy: ${MODES[config.mode].description}`,
    `Project: ${projectDirectory}`,
    `Tool output limit: ${config.limits.toolOutputChars} characters`,
    `Parallel tasks: ${config.limits.parallelTasks}`,
    `Mode delivered to: ${(config.memoryFiles ?? []).join(", ") || "(nothing -- memoryFiles is empty)"}`,
    `Compaction: ${config.compaction.enabled ? "on" : "off"} (${config.compaction.backend}, ${config.compaction.model})`,
    `Backend: ${COMPACTION_BACKENDS[config.compaction.backend].description}`
  ].join("\n");
}

function renderReport(summary) {
  const lines = [
    `Recorded entries: ${summary.sessions}`,
    `Tokens: ${summary.totalTokens.toLocaleString()}`,
    `Input: ${summary.inputTokens.toLocaleString()}`,
    `Output: ${summary.outputTokens.toLocaleString()}`,
    `Cache read: ${summary.cacheReadTokens.toLocaleString()}`,
    `Cache write: ${summary.cacheWriteTokens.toLocaleString()}`,
    `Recorded cost: $${summary.costUsd.toFixed(4)}`
  ];
  for (const [host, value] of Object.entries(summary.byHost)) {
    lines.push(`${host}: ${value.totalTokens.toLocaleString()} tokens across ${value.sessions} entries`);
  }
  return lines.join("\n");
}

/**
 * The model for an effective backend. A `--backend` override that keeps the
 * other backend's model name sends `jev-latest` to the gateway, or
 * `typesafe-ai/jev` to TypeSafe's own API; both are rejected upstream.
 */
function resolveModel(parsed, config, backend) {
  if (parsed.model) return parsed.model;
  if (backend !== config.compaction.backend) return COMPACTION_BACKENDS[backend].defaultModel;
  return config.compaction.model;
}

/**
 * Puts the mode where the hosts will actually read it. `.jev/config.json` is
 * never loaded by a session, so without this a mode set in a terminal would
 * reach nothing.
 */
async function deliverMode(projectDirectory, config, mode, parsed) {
  if (parsed["no-memory"]) return "";
  const files = config.memoryFiles ?? [];
  if (files.length === 0) return "";
  const changed = await applyModeMemory(projectDirectory, mode, {
    files,
    description: MODES[mode].description
  });
  if (changed.length === 0) return "";
  return mode === "off"
    ? ` Removed the jev block from ${changed.join(", ")}.`
    : ` Wrote the mode into ${changed.join(", ")} so sessions pick it up.`;
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const parsed = options(rest);
  const projectDirectory = path.resolve(process.cwd());

  if (["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
    return;
  }

  if (command === "init") {
    const mode = parsed.mode ?? "full";
    assertMode(mode);
    const target = configPath(projectDirectory);
    const exists = await access(target).then(() => true, () => false);
    if (exists && !parsed.force) {
      throw new Error(
        `${target} already exists. Run "jev mode ${mode}" to change the mode without resetting limits and compaction settings, or pass --force to reset it.`
      );
    }
    const config = { ...defaultConfig(), mode };
    await saveConfig(projectDirectory, config);
    const delivered = await deliverMode(projectDirectory, config, mode, parsed);
    console.log(`${exists ? "Reset" : "Created"} ${target} with ${mode} mode.${delivered}`);
    return;
  }

  if (command === "mode") {
    const mode = parsed._[0];
    assertMode(mode);
    const config = await loadConfig(projectDirectory);
    config.mode = mode;
    let note = "";
    if (mode === "off" && config.compaction.enabled) {
      config.compaction.enabled = false;
      note = " Compaction disabled: mode off is an absolute kill switch for JEV calls.";
    }
    const target = await saveConfig(projectDirectory, config);
    const delivered = await deliverMode(projectDirectory, config, mode, parsed);
    console.log(`jev mode set to ${mode}. Saved ${target}.${note}${delivered}`);
    return;
  }

  if (command === "status") {
    const config = await loadConfig(projectDirectory);
    const status = { project: projectDirectory, ...config, policy: MODES[config.mode].description };
    console.log(parsed.json ? JSON.stringify(status, null, 2) : renderStatus(config, projectDirectory));
    return;
  }

  if (command === "record") {
    const record = await appendRecord(projectDirectory, {
      host: parsed.host,
      model: parsed.model,
      project: parsed.project,
      task: parsed.task,
      inputTokens: parsed.input,
      outputTokens: parsed.output,
      cacheReadTokens: parsed["cache-read"],
      cacheWriteTokens: parsed["cache-write"],
      costUsd: parsed.cost
    });
    console.log(`Recorded ${record.totalTokens.toLocaleString()} tokens for ${record.host}/${record.model}.`);
    return;
  }

  if (command === "report") {
    const skipped = [];
    const summary = summarizeRecords(await readRecords(projectDirectory, { onInvalid: (detail) => skipped.push(detail) }));
    if (skipped.length > 0) summary.skippedLines = skipped.map((detail) => detail.line);
    console.log(parsed.json ? JSON.stringify(summary, null, 2) : renderReport(summary));
    if (skipped.length > 0 && !parsed.json) {
      console.error(
        `jev: skipped ${skipped.length} unreadable line(s) in .jev/usage.jsonl (line ${skipped.map((d) => d.line).join(", ")}). Totals above exclude them; delete those lines to silence this.`
      );
    }
    return;
  }

  if (command === "classify") {
    const prompt = parsed._.join(" ").trim();
    if (!prompt) throw new Error('jev classify requires a prompt, e.g. jev classify "fix the failing test".');
    const config = await loadConfig(projectDirectory);
    if (config.mode === "off") {
      throw new Error('jev mode is "off", which disables all JEV calls. Run "jev mode <lite|full|ultra>" first.');
    }
    const backend = parsed.backend ?? config.compaction.backend;
    assertCompactionBackend(backend);
    const model = resolveModel(parsed, config, backend);
    const result = await classifyPrompt(prompt, {
      backend,
      model,
      baseUrl: parsed["base-url"],
      requestTimeoutMs: config.compaction.requestTimeoutMs,
      minConfidence: config.autoMode.minConfidence,
      fallback: config.autoMode.fallback
    });

    if (result.usage && (result.usage.input_tokens > 0 || result.usage.output_tokens > 0)) {
      await appendRecord(projectDirectory, {
        host: "jev",
        model,
        task: "classify",
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens
      });
    }

    if (parsed.apply) {
      const next = await loadConfig(projectDirectory);
      next.mode = result.mode;
      await saveConfig(projectDirectory, next);
      await deliverMode(projectDirectory, next, result.mode, parsed);
    }

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const note =
      result.reason === "low-confidence"
        ? ` (suggested ${result.suggested} at ${result.confidence.toFixed(2)}, below the ${config.autoMode.minConfidence} floor, so kept ${result.mode})`
        : ` (confidence ${result.confidence.toFixed(2)})`;
    console.log(`mode: ${result.mode}${note}${parsed.apply ? " — applied" : ""}`);
    return;
  }

  if (command === "compaction") {
    const toggle = parsed._[0];
    if (toggle !== "on" && toggle !== "off") throw new Error('jev compaction requires "on" or "off".');
    const config = await loadConfig(projectDirectory);
    if (toggle === "on" && config.mode === "off") {
      throw new Error('jev mode is "off", which disables all JEV calls. Run "jev mode <lite|full|ultra>" first, then "jev compaction on".');
    }
    config.compaction.enabled = toggle === "on";
    if (parsed.backend) {
      assertCompactionBackend(parsed.backend);
      const switching = parsed.backend !== config.compaction.backend;
      config.compaction.backend = parsed.backend;
      if (switching && !parsed.model) config.compaction.model = COMPACTION_BACKENDS[parsed.backend].defaultModel;
    }
    if (parsed.model) config.compaction.model = parsed.model;
    const target = await saveConfig(projectDirectory, config);
    console.log(`jev compaction ${toggle} (${config.compaction.backend}, ${config.compaction.model}). Saved ${target}.`);
    return;
  }

  if (command === "compact") {
    const transcriptPath = parsed._[0];
    if (!transcriptPath) throw new Error("jev compact requires a transcript JSON file path.");
    const config = await loadConfig(projectDirectory);
    if (config.mode === "off") {
      throw new Error('jev mode is "off", which disables all JEV calls. Run "jev mode <lite|full|ultra>" first.');
    }
    if (!config.compaction.enabled) {
      throw new Error('Compaction is off. Run "jev compaction on" first.');
    }
    const backend = parsed.backend ?? config.compaction.backend;
    assertCompactionBackend(backend);
    const model = resolveModel(parsed, config, backend);
    const messages = JSON.parse(await readFile(path.resolve(transcriptPath), "utf8"));
    if (!Array.isArray(messages)) {
      throw new Error(
        `${transcriptPath} must contain a JSON array of messages, e.g. [{"role":"assistant","text":"...","toolUses":[...]}]. Received ${messages === null ? "null" : Array.isArray(messages) ? "an array" : typeof messages}.`
      );
    }

    const result = await compactMessages(messages, {
      backend,
      model,
      baseUrl: parsed["base-url"],
      keepThreshold: config.compaction.keepThreshold,
      preserveRecentMessages: config.compaction.preserveRecentMessages,
      maxStateTokens: config.compaction.maxStateTokens,
      maxRequestTokens: config.compaction.maxRequestTokens,
      truncateHeadChars: config.compaction.truncateHeadChars,
      minDropChars: config.compaction.minDropChars,
      resultExcerptChars: config.compaction.resultExcerptChars,
      maxConcurrentRequests: config.compaction.maxConcurrentRequests,
      maxRequests: config.compaction.maxRequests,
      requestTimeoutMs: config.compaction.requestTimeoutMs,
      maxGoalChars: config.compaction.maxGoalChars
    });

    if (result.usage && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0)) {
      await appendRecord(projectDirectory, {
        host: "jev",
        model,
        task: "compaction",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens
      });
    }

    console.log(parsed.json ? JSON.stringify(result, null, 2) : summarize(result));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`jev: ${error.message}`);
  process.exitCode = 1;
});
