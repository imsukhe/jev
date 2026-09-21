import { buildJevRequest, parseJevResponse } from "./jevProtocol.mjs";

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Asks Jev directly over HTTP against TypeSafe's System One endpoint.
 * @implements {import('./compaction.mjs').JevAsker}
 */
export class TypeSafeJevClient {
  /**
   * @param {{apiKey?: string, model?: string, baseUrl?: string, fetch?: typeof fetch, timeoutMs?: number}} [options]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? "";
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ask(state, questions) {
    if (!this.apiKey) throw new Error("TYPESAFE_API_KEY is not configured");
    const request = buildJevRequest({ apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl }, state, questions);
    // Without a deadline a stalled request hangs compaction forever, and the
    // Claude Code hook never reaches the built-in-summary fallback it
    // promises. A timeout has to surface as a normal rejection instead.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // The timer stays armed until the body is read: a response whose headers
    // arrive promptly can still stall forever mid-body, which would hang
    // compaction just as completely as a stalled connection.
    try {
      const response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal
      });
      const text = await response.text();
      return parseJevResponse(response.status, response.ok, text);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Jev request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
