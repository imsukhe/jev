// Node-side entry point for classification, mirroring compactMessages.mjs.
import { classifyWithAsker } from "./classify.mjs";
import { askerForBackend } from "./backends.mjs";

/** Classifies a prompt into a mode using the configured backend. */
export async function classifyPrompt(prompt, options = {}) {
  return classifyWithAsker(prompt, askerForBackend(options), options);
}
