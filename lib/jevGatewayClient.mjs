const DEFAULT_GATEWAY_MODEL = "typesafe-ai/jev";
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Asks Jev through Vercel AI Gateway. Requires the `ai` and `@ai-sdk/gateway`
 * packages and one of the auth methods `@ai-sdk/gateway` itself resolves, in
 * this order (verified by reading its getGatewayAuthToken in
 * node_modules/@ai-sdk/gateway/dist/index.js, not just its docs): an
 * `AI_GATEWAY_API_KEY` env var (a Vercel AI Gateway API key, created at
 * vercel.com without needing a linked project -- the simplest option), or a
 * `VERCEL_OIDC_TOKEN` env var (`vercel link` then `vercel env pull`) as a
 * fallback. This client does not manage or read either itself; the SDK does.
 *
 * Vercel's evaluation contract (verified against the installed `ai`/
 * `@ai-sdk/gateway` packages' type declarations, not the marketing docs,
 * which show a `type: 'boolean'` question and `{refunded: {type,
 * probability}}` example that is missing the real `answers` wrapper) uses
 * generic question types `'choice' | 'score' | 'boolean'` -- there is no
 * `'noul'` type here, unlike TypeSafe's own direct API. A `'boolean'`
 * question/answer is otherwise the same shape as TypeSafe's `'noul'`
 * question/answer, so this client only translates the `type` field and the
 * `probability`/`noul` field name, both ways.
 * @implements {import('./compaction.mjs').JevAsker}
 */
export class VercelGatewayJevClient {
  /**
   * @param {{model?: string, evaluate?: Function, gatewayModel?: (id: string) => unknown}} [options]
   */
  constructor(options = {}) {
    this.model = options.model ?? DEFAULT_GATEWAY_MODEL;
    this.injectedEvaluate = options.evaluate;
    this.injectedGatewayModel = options.gatewayModel;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async #resolveModel() {
    if (this.injectedGatewayModel) return this.injectedGatewayModel(this.model);
    const { gateway } = await import("@ai-sdk/gateway");
    return gateway.evaluationModel(this.model);
  }

  async #resolveEvaluate() {
    if (this.injectedEvaluate) return this.injectedEvaluate;
    // The `ai` package exports this as `experimental_evaluate`, not
    // `evaluate` (verified against the installed package).
    const { experimental_evaluate: evaluate } = await import("ai");
    return evaluate;
  }

  async ask(state, questions) {
    const [evaluate, model] = await Promise.all([this.#resolveEvaluate(), this.#resolveModel()]);
    // Bounded so a stalled request cannot leave compaction pending forever;
    // the hook depends on failures arriving to reach its fallback.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let result;
    try {
      result = await evaluate({ model, state, questions: toGatewayQuestions(questions), abortSignal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Jev request timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return {
      answers: fromGatewayAnswers(result.answers),
      usage: result.usage
        ? { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens }
        : undefined
    };
  }
}

/** TypeSafe's `noul` question type maps 1:1 to the gateway's `boolean` type. */
export function toGatewayQuestions(questions) {
  const translated = Object.create(null);
  for (const name of Object.keys(questions)) {
    const question = questions[name];
    translated[name] = question.type === "noul" ? { ...question, type: "boolean" } : question;
  }
  return translated;
}

/**
 * Normalizes gateway answers into the shapes the rest of the code expects.
 * A `boolean` answer carries `probability` and becomes TypeSafe's `{noul}`;
 * `choice` and `score` answers already match and pass through untouched.
 */
export function fromGatewayAnswers(answers) {
  if (!answers || typeof answers !== "object") throw new Error("Jev gateway response is missing answers");
  const normalized = Object.create(null);
  for (const name of Object.keys(answers)) {
    const entry = answers[name];
    if (!entry || typeof entry !== "object") throw new Error(`Invalid Jev gateway answer for ${name}`);
    if (typeof entry.choice === "string" || typeof entry.score === "number") {
      normalized[name] = entry;
      continue;
    }
    if (typeof entry.probability !== "number" || !Number.isFinite(entry.probability)) {
      throw new Error(`Invalid Jev gateway answer for ${name}`);
    }
    normalized[name] = { noul: entry.probability };
  }
  return normalized;
}
