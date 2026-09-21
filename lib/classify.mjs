import { MODES } from "./config.mjs";

export const QUESTION_ID = "mode";

// What each mode means to the classifier, in terms of the work rather than
// the tone of the request. The wording matters: asked without these, or
// asked about "urgency", the model follows how a request is phrased instead
// of what it would actually do.
export const MODE_CRITERIA = Object.freeze({
  ultra:
    "Bounded, low-risk, and unambiguous: a small edit or lookup where the correct action is already clear. The agent should act directly with minimal exploration or verification.",
  lite: "Mostly read-only or explanatory: needs understanding and a clear answer, but no risky change, so no deep verification or broad search is warranted.",
  full: "Risky, ambiguous, or correctness-critical: production impact, security, data integrity, irreversible actions, or an unclear root cause. Effort must not be minimised."
});

export const CLASSIFY_CONTEXT =
  "The request below is one a coding agent is about to start. Choose how aggressively the agent should minimise its own effort and token spend on it. Judge the actual risk and scope of the work, not the tone or urgency of the wording.";

/** The state and question for one classification. */
export function buildClassifyRequest(prompt) {
  return {
    state: { context: CLASSIFY_CONTEXT, request: prompt },
    questions: {
      [QUESTION_ID]: {
        type: "choice",
        instructions: "Which effort mode should the agent use for this request?",
        criteria: MODE_CRITERIA
      }
    }
  };
}

/** The winning option's probability, or 0 when the model reported none. */
export function answerConfidence(answer) {
  if (typeof answer?.confidence === "number" && Number.isFinite(answer.confidence)) return answer.confidence;
  const probabilities = answer?.probabilities;
  if (!probabilities || typeof probabilities !== "object") return 0;
  const values = Object.values(probabilities).filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : 0;
}

/**
 * Turns an answer into a mode, conservatively.
 *
 * Downgrading effort is the move that can hurt: measured against the live
 * model, "tiny fix: change the auth check from === to == in login.ts" came
 * back as `ultra` -- but at 0.60, where every correct answer in the same
 * run scored 0.93 or better. So a low-confidence answer never buys a
 * cheaper mode; it falls back to `full`. Choosing `full` needs no
 * confidence, because `full` is the careful option already.
 */
export function decideMode(answer, options = {}) {
  const fallback = options.fallback ?? "full";
  const minConfidence = options.minConfidence ?? 0.85;
  const choice = answer?.choice;
  const confidence = answerConfidence(answer);

  if (typeof choice !== "string" || !(choice in MODES)) {
    return { mode: fallback, confidence, reason: "unrecognized-choice", suggested: choice ?? null };
  }
  if (choice === fallback) return { mode: choice, confidence, reason: "chosen", suggested: choice };
  if (confidence < minConfidence) {
    return { mode: fallback, confidence, reason: "low-confidence", suggested: choice };
  }
  return { mode: choice, confidence, reason: "chosen", suggested: choice };
}

/** Classifies one prompt with an already-built asker. */
export async function classifyWithAsker(prompt, asker, options = {}) {
  const { state, questions } = buildClassifyRequest(prompt);
  const response = await asker.ask(state, questions);
  const answer = response?.answers?.[QUESTION_ID];
  const decision = decideMode(answer, options);
  return { ...decision, usage: response?.usage };
}
