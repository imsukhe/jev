import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { ledgerPath } from "./config.mjs";

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

function numberOrZero(value) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Expected non-negative number, received: ${value}`);
  return parsed;
}

export function normalizeRecord(record) {
  if (!record.host) throw new Error("Usage records require host.");
  if (!record.model) throw new Error("Usage records require model.");

  const normalized = {
    timestamp: record.timestamp ?? new Date().toISOString(),
    host: record.host,
    model: record.model,
    project: record.project ?? null,
    task: record.task ?? null,
    inputTokens: numberOrZero(record.inputTokens),
    outputTokens: numberOrZero(record.outputTokens),
    cacheReadTokens: numberOrZero(record.cacheReadTokens),
    cacheWriteTokens: numberOrZero(record.cacheWriteTokens),
    costUsd: numberOrZero(record.costUsd)
  };
  normalized.totalTokens = TOKEN_FIELDS.reduce((total, field) => total + normalized[field], 0);
  return normalized;
}

export async function appendRecord(projectDirectory, record) {
  const target = ledgerPath(projectDirectory);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(target), { recursive: true }));
  const normalized = normalizeRecord(record);
  await appendFile(target, `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

/**
 * Reads the append-only ledger, skipping lines it cannot parse.
 *
 * Throwing on the first bad line meant one torn write -- a process killed
 * mid-append, a full disk -- permanently broke `jev report` and the audit
 * skill, while appends kept succeeding: an append-only log nobody could
 * read, with no repair path but hand-editing. A damaged line is reported
 * through `onInvalid` and dropped, so the rest of the history survives it.
 *
 * @param {string} projectDirectory
 * @param {{onInvalid?: (detail: {line: number, message: string}) => void}} [options]
 */
export async function readRecords(projectDirectory, options = {}) {
  const onInvalid = options.onInvalid;
  try {
    const raw = await readFile(ledgerPath(projectDirectory), "utf8");
    const records = [];
    raw.split("\n").forEach((line, index) => {
      if (!line) return;
      try {
        records.push(normalizeRecord(JSON.parse(line)));
      } catch (error) {
        onInvalid?.({ line: index + 1, message: error.message });
      }
    });
    return records;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function summarizeRecords(records) {
  const summary = {
    sessions: records.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    byHost: Object.create(null),
    byModel: Object.create(null)
  };

  for (const record of records) {
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd"]) {
      summary[field] += record[field];
    }
    for (const [key, value] of [["byHost", record.host], ["byModel", record.model]]) {
      summary[key][value] ??= { sessions: 0, totalTokens: 0, costUsd: 0 };
      summary[key][value].sessions += 1;
      summary[key][value].totalTokens += record.totalTokens;
      summary[key][value].costUsd += record.costUsd;
    }
  }
  return summary;
}
