// Verified against Claude Code 2.1.278: `claude plugin validate` accepts this
// module and resolves every `$` call it makes, and loading the repo with
// `--plugin-dir` reports `hooks module jev@inline loaded (worker,
// environment 1); events: session.compact,turn.complete`, with
// `turn.complete` settling in 0.8ms on its disabled fast path. So the module
// loads in the real sandboxed worker and both events register.
//
// Still unverified: a live `session.compact` carrying a real transcript,
// which needs an authenticated session long enough to compact plus an API
// key. Every path here falls through to `next(event)` or logs and continues,
// so a failure should degrade to Claude Code's built-in compaction rather
// than break a session. The function-hook surface is early access and not in
// the public docs at code.claude.com/docs/en/hooks, so it may change.
//
// Runs in the hook sandbox: no Node, no global fetch (see
// types/claude-code.d.ts in the reference above: "A hooks module runs in an
// environment of its own: no DOM, no Node"). Only TypeSafe-direct is wired
// up here for that reason -- the `ai`/`@ai-sdk/gateway` SDK used for the
// Vercel Gateway backend is a Node-oriented package not confirmed to load
// in this sandbox. Use `jev compact --backend vercel-gateway` (a normal
// Node process) for that backend instead.

import { buildJevRequest, parseJevResponse } from "../lib/jevProtocol.mjs";
import { compact, reductionRatio, summarize } from "../lib/compaction.mjs";

const DEFAULTS = {
  enabled: false,
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  truncateHeadChars: 300,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  requestTimeoutMs: 60000,
  maxRequests: 24,
  maxConcurrentRequests: 4,
  maxGoalChars: 2000,
  model: "jev-latest"
};

function optionNumber(options, key, fallback) {
  const value = options[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionString(options, key) {
  const value = options[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Reads the plugin's `userConfig` values; anything missing takes the
 * default. `enabled` (default false) is this hook's own on/off switch --
 * the hook sandbox cannot read this project's .jev/config.json (no
 * filesystem access), so the CLI's "jev compaction on/off" cannot reach it.
 * Set `enabled` via the plugin's own settings (Claude Code's /config) to
 * turn this hook on.
 */
export function resolveHookConfig(options) {
  const config = { ...DEFAULTS };
  config.enabled = options.enabled === true;
  for (const key of ["keepThreshold", "preserveRecentMessages", "maxStateTokens", "maxRequestTokens", "truncateHeadChars", "compactAtPercent", "minReductionRatio", "requestTimeoutMs", "maxRequests", "maxConcurrentRequests", "maxGoalChars"]) {
    config[key] = optionNumber(options, key, DEFAULTS[key]);
  }
  config.model = optionString(options, "model") ?? DEFAULTS.model;
  const apiKey = optionString(options, "apiKey");
  if (apiKey) config.apiKey = apiKey;
  return config;
}

async function getApiKey($, config) {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get("TYPESAFE_API_KEY");
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings?.env;
  if (env && typeof env === "object" && typeof env.TYPESAFE_API_KEY === "string") return env.TYPESAFE_API_KEY;
  return undefined;
}

/** A JevAsker over the engine's `$.http.fetch`, never Node's global fetch. */
function jevAsker($, apiKey, model, timeoutMs) {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const fetching = $.http.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });
      // Without a deadline a stalled request never settles, so the compaction
      // never finishes and the built-in-summary fallback this hook promises
      // is never reached -- the exact failure the fallback exists for.
      // `$.clock.after` is spelled at the call site on purpose: the engine
      // rejects a module that reads `$.clock` as a value.
      const response = await Promise.race([
        fetching,
        $.clock.after(timeoutMs).then(() => {
          throw new Error(`Jev request timed out after ${timeoutMs}ms`);
        })
      ]);
      // $.http.fetch's response carries `text` as an already-read string,
      // not a method (unlike the standard Fetch API) -- per the reference's
      // HookFetchResponse type.
      return parseJevResponse(response.status, response.ok, response.text);
    }
  };
}

function percent(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

const UI_LOG_MAX_CHARS = 4096;

function decisionLog(result) {
  return result.decisions
    .filter((d) => d.reason !== "pinned")
    .map((d) => `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`)
    .join(" ");
}

function decisionLogLines(result, maxChars = UI_LOG_MAX_CHARS) {
  const entries = decisionLog(result).split(" ").filter(Boolean);
  if (entries.length === 0) return ["decisions: (none)"];
  const chunks = [];
  let current = "";
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) => (chunks.length === 1 ? `decisions: ${chunk}` : `decisions (${index + 1}/${chunks.length}): ${chunk}`));
}

function notify($, text) {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15000 });
}

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  const config = resolveHookConfig(options);
  let compacting = false;

  on("session.compact", async ($, event, next) => {
    if (!config.enabled) return next(event);
    try {
      const apiKey = await getApiKey($, config);
      if (!apiKey) throw new Error("TYPESAFE_API_KEY is not configured");
      const asker = jevAsker($, apiKey, config.model, config.requestTimeoutMs);
      const result = await compact(event.messages, asker, {
        keepThreshold: config.keepThreshold,
        preserveRecentMessages: config.preserveRecentMessages,
        maxStateTokens: config.maxStateTokens,
        maxRequestTokens: config.maxRequestTokens,
        truncateHeadChars: config.truncateHeadChars,
        // Forwarded so the fan-out refusal, which tells the user to raise
        // maxRequests, names a setting this hook actually reads.
        maxRequests: config.maxRequests,
        maxConcurrentRequests: config.maxConcurrentRequests,
        maxGoalChars: config.maxGoalChars
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify($, `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`);
        return next(event);
      }
      notify($, `kept ${result.messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`);
      return { messages: result.messages };
    } catch (error) {
      notify($, `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`);
      return next(event);
    }
  });

  on("turn.complete", async ($, event, next) => {
    if (!config.enabled || compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context?.percent ?? 0) < config.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(`auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
