import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MEMORY_FILES } from "./modeMemory.mjs";

export const MODES = Object.freeze({
  off: {
    description: "Use host defaults. Record usage only, and make no JEV calls."
  },
  lite: {
    description: "Keep answers concise and avoid duplicate reads."
  },
  full: {
    description: "Use targeted context, bounded tool output, focused verification, and no speculative delegation."
  },
  ultra: {
    description: "Use summary-first context and the smallest adequate execution path. Escalate only for evidence-based risk."
  }
});

// Each backend names the model differently: TypeSafe's own API takes
// `jev-latest`, the gateway takes the `typesafe-ai/jev` catalog id. Sending
// one backend's name to the other is rejected, so switching backends resets
// the model unless the user pins one explicitly.
export const COMPACTION_BACKENDS = Object.freeze({
  typesafe: {
    defaultModel: "jev-latest",
    description: "Call TypeSafe's JEV model directly (TYPESAFE_API_KEY). Requires a TypeSafe console invite."
  },
  "vercel-gateway": {
    defaultModel: "typesafe-ai/jev",
    description: "Call typesafe-ai/jev through Vercel AI Gateway (AI_GATEWAY_API_KEY, or VERCEL_OIDC_TOKEN via `vercel link`/`vercel env pull`)."
  }
});

export function defaultConfig() {
  return {
    schemaVersion: 1,
    mode: "full",
    limits: {
      toolOutputChars: 12000,
      parallelTasks: 1
    },
    // Files `jev mode` writes the active mode into, because these are what
    // the hosts load on their own. Empty the list to opt out entirely.
    memoryFiles: [...DEFAULT_MEMORY_FILES],
    // Used by `jev classify`. A low-confidence answer never buys a cheaper
    // mode -- see lib/classify.mjs for the measurement behind that.
    autoMode: {
      minConfidence: 0.85,
      fallback: "full"
    },
    compaction: {
      enabled: false,
      backend: "typesafe",
      model: "jev-latest",
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25000,
      maxRequestTokens: 30000,
      truncateHeadChars: 300,
      minDropChars: 300,
      resultExcerptChars: 240,
      maxConcurrentRequests: 4,
      maxRequests: 24,
      requestTimeoutMs: 60000,
      maxGoalChars: 2000
    }
  };
}

export function configPath(projectDirectory) {
  return path.join(projectDirectory, ".jev", "config.json");
}

export function ledgerPath(projectDirectory) {
  return path.join(projectDirectory, ".jev", "usage.jsonl");
}

export function assertMode(mode) {
  if (!(mode in MODES)) {
    throw new Error(`Unknown mode: ${mode}. Expected one of: ${Object.keys(MODES).join(", ")}.`);
  }
}

export function assertCompactionBackend(backend) {
  if (!(backend in COMPACTION_BACKENDS)) {
    throw new Error(`Unknown compaction backend: ${backend}. Expected one of: ${Object.keys(COMPACTION_BACKENDS).join(", ")}.`);
  }
}

// Upper bounds for anything that multiplies spend or size. `.jev/config.json`
// arrives with a cloned repository, so a value read from it is untrusted
// input, not a preference: without these a repo could set maxRequests to
// 100000 and the advertised cost guard would be decoration.
const NUMERIC_LIMITS = Object.freeze({
  keepThreshold: { min: 0, max: 1 },
  preserveRecentMessages: { min: 0, max: 1000 },
  maxStateTokens: { min: 1, max: 200000 },
  maxRequestTokens: { min: 1, max: 200000 },
  truncateHeadChars: { min: 0, max: 100000 },
  minDropChars: { min: 0, max: 100000 },
  resultExcerptChars: { min: 0, max: 10000 },
  maxConcurrentRequests: { min: 1, max: 16 },
  maxRequests: { min: 1, max: 64 },
  maxGoalChars: { min: 100, max: 100000 },
  requestTimeoutMs: { min: 1000, max: 600000 }
});

const AUTO_MODE_LIMITS = Object.freeze({ minConfidence: { min: 0, max: 1 } });

/** Clamps a numeric field into range, falling back when it is not a number. */
function clampNumbers(values, limits, fallback, where) {
  const out = { ...values };
  for (const [key, range] of Object.entries(limits)) {
    const value = out[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      out[key] = fallback[key];
      continue;
    }
    if (value < range.min || value > range.max) {
      process.emitWarning(
        `jev: ${where}.${key} = ${value} is outside ${range.min}..${range.max}; clamped. Check .jev/config.json.`
      );
      out[key] = Math.min(range.max, Math.max(range.min, value));
    }
  }
  return out;
}

export async function loadConfig(projectDirectory) {
  try {
    const raw = await readFile(configPath(projectDirectory), "utf8");
    const parsed = JSON.parse(raw);
    assertMode(parsed.mode);
    const config = {
      ...defaultConfig(),
      ...parsed,
      limits: { ...defaultConfig().limits, ...parsed.limits },
      autoMode: { ...defaultConfig().autoMode, ...parsed.autoMode },
      compaction: { ...defaultConfig().compaction, ...parsed.compaction }
    };
    assertCompactionBackend(config.compaction.backend);
    const defaults = defaultConfig();
    config.compaction = clampNumbers(config.compaction, NUMERIC_LIMITS, defaults.compaction, "compaction");
    config.autoMode = clampNumbers(config.autoMode, AUTO_MODE_LIMITS, defaults.autoMode, "autoMode");
    if (!Array.isArray(config.memoryFiles)) config.memoryFiles = [...defaults.memoryFiles];
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return defaultConfig();
    throw error;
  }
}

export async function saveConfig(projectDirectory, config) {
  assertMode(config.mode);
  assertCompactionBackend(config.compaction?.backend ?? "typesafe");
  const target = configPath(projectDirectory);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return target;
}
