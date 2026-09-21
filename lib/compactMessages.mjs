// Node-side entry point: picks a backend client and runs the engine.
//
// Kept separate from lib/compaction.mjs on purpose. The Claude Code hook
// runs in a sandbox with no Node, builds its own asker over `$.http.fetch`,
// and imports only the engine — so the engine must never pull a client (and
// through it `process`, `fetch`, or the `ai` SDK) into that sandbox.
import { compact } from "./compaction.mjs";
import { askerForBackend } from "./backends.mjs";

/** Picks the asker for `options.backend` and calls compact(). */
export async function compactMessages(messages, options = {}) {
  return compact(messages, askerForBackend(options), options);
}
