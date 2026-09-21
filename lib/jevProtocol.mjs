export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

/**
 * Builds the HTTP request for one Jev call, for any fetch-like transport.
 * @param {{apiKey: string, model?: string, baseUrl?: string}} params
 * @param {string|object} state
 * @param {Record<string, object>} questions
 */
export function buildJevRequest(params, state, questions) {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions
    })
  };
}

/**
 * Validates a Jev response body; throws on anything but an `answers` object.
 * @param {number} status
 * @param {boolean} ok
 * @param {string} text
 */
export function parseJevResponse(status, ok, text) {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Jev returned malformed JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Jev response is missing answers");
  }
  const answers = Object.prototype.hasOwnProperty.call(parsed, "answers") ? parsed.answers : undefined;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error("Jev response is missing answers");
  }
  return parsed;
}

/**
 * The `noul` probability of one answer; throws when it is not there.
 * @param {Record<string, {noul?: number}>} answers
 * @param {string} name
 */
export function noulAnswer(answers, name) {
  const answer = Object.prototype.hasOwnProperty.call(answers, name) ? answers[name] : undefined;
  if (!answer || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
