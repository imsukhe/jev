// Backend selection lives here, apart from lib/compaction.mjs and
// lib/classify.mjs, so neither engine pulls a Node-shaped client into the
// Claude Code hook sandbox just by being imported.
import { TypeSafeJevClient } from "./jevClient.mjs";
import { VercelGatewayJevClient } from "./jevGatewayClient.mjs";

export function askerForBackend(options = {}) {
  if (options.backend === "vercel-gateway") {
    return new VercelGatewayJevClient({ model: options.model, timeoutMs: options.requestTimeoutMs });
  }
  return new TypeSafeJevClient({
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    timeoutMs: options.requestTimeoutMs
  });
}
