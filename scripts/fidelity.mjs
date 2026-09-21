// Test 0: does the work still survive the compaction?
//
// Reduction is meaningless on its own. The question is whether a transcript
// that has been compacted still answers the same task-relevant questions as
// the original. Three variants, identical questions, compared:
//
//   full      - the original transcript
//   jev       - compacted by asking JEV what still matters
//   recency   - naive truncation to the same size, keeping the newest
//
// The recency arm is the control: if it scores as well as jev, the model is
// not earning its keep and plain truncation would do.
import { readFileSync } from "node:fs";
import { experimental_evaluate as evaluate } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { compact } from "../lib/compaction.mjs";
import { VercelGatewayJevClient } from "../lib/jevGatewayClient.mjs";

const transcriptPath = process.argv[2] ?? new URL("../examples/debug-session.json", import.meta.url).pathname;
const messages = JSON.parse(readFileSync(transcriptPath, "utf8"));

// Ground truth, from the transcript itself.
const QUESTIONS = {
  buggy_file: {
    want: "handler",
    instructions: "Which file contained the bug that was fixed?",
    criteria: {
      handler: "src/checkout/handler.ts",
      limits: "src/checkout/limits.ts",
      legacy: "src/legacy/billing_v1.ts",
      unknown: "The transcript does not say."
    }
  },
  the_fix: {
    want: "return402",
    instructions: "What did the fix change the over-limit behaviour to?",
    criteria: {
      return402: "Return a 402 response instead of throwing.",
      throw: "Throw an error.",
      return500: "Return a 500 response.",
      unknown: "The transcript does not say."
    }
  },
  limit_value: {
    want: "thousand",
    instructions: "What is the order limit for a non-pro user?",
    criteria: {
      thousand: "1000",
      hundredk: "100000",
      fourothree: "402",
      unknown: "The transcript does not say."
    }
  },
  forbidden_path: {
    want: "generated",
    instructions: "Which path did the user say must not be touched?",
    criteria: {
      generated: "src/generated/",
      legacy: "src/legacy/",
      tests: "test/",
      unknown: "The transcript does not say."
    }
  },
  tests_pass: {
    want: "passed",
    instructions: "After the fix was applied, did the checkout tests pass?",
    criteria: {
      passed: "Yes, they all passed.",
      failed: "No, at least one still failed.",
      unknown: "The transcript does not say."
    }
  },
  next_task: {
    want: "regression",
    instructions: "What did the user most recently ask for?",
    criteria: {
      regression: "A regression test for the 402 path, and a changelog update.",
      migration: "A database migration.",
      refactor: "A refactor of the payment module.",
      unknown: "The transcript does not say."
    }
  }
};

function render(msgs) {
  return msgs
    .map((m, i) => {
      const calls = (m.toolUses ?? []).map((t) => `    [tool ${t.tool} ${JSON.stringify(t.input)}]`).join("\n");
      const results = (m.toolResults ?? []).map((r) => `    [result] ${r.text}`).join("\n");
      return [`(${i}) ${m.role}: ${m.text ?? ""}`, calls, results].filter(Boolean).join("\n");
    })
    .join("\n");
}

const chars = (msgs) => render(msgs).length;

/** Naive baseline: keep the newest messages that fit the same budget. */
function recencyTruncate(msgs, budget) {
  const kept = [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const next = [msgs[i], ...kept];
    if (chars(next) > budget && kept.length > 0) break;
    kept.unshift(msgs[i]);
  }
  return kept;
}

async function ask(label, msgs) {
  const { answers } = await evaluate({
    model: gateway.evaluationModel("typesafe-ai/jev"),
    state: { context: "A coding agent's transcript. Answer from it alone; say it does not say when the transcript does not contain the answer.", transcript: render(msgs) },
    questions: Object.fromEntries(
      Object.entries(QUESTIONS).map(([id, q]) => [id, { type: "choice", instructions: q.instructions, criteria: q.criteria }])
    )
  });
  let kept = 0;
  const detail = [];
  for (const [id, q] of Object.entries(QUESTIONS)) {
    const got = answers[id].choice;
    const ok = got === q.want;
    if (ok) kept += 1;
    detail.push(`${ok ? "  " : " ✗"}${id.padEnd(15)} ${got}`);
  }
  console.log(`\n=== ${label} === ${chars(msgs)} chars, ${msgs.length} messages`);
  console.log(detail.join("\n"));
  console.log(`  answers preserved: ${kept}/${Object.keys(QUESTIONS).length}`);
  return kept;
}

const client = new VercelGatewayJevClient({ model: "typesafe-ai/jev" });
const result = await compact(messages, client, { preserveRecentMessages: 6 });
const compacted = result.messages;
const truncated = recencyTruncate(messages, chars(compacted));

const total = Object.keys(QUESTIONS).length;
const full = await ask("FULL (control)", messages);
const jev = await ask("JEV-COMPACTED", compacted);
const rec = await ask("RECENCY-TRUNCATED (same size)", truncated);

console.log("\n──────── test 0 ────────");
console.log(`full       ${full}/${total}   ${chars(messages)} chars`);
console.log(`jev        ${jev}/${total}   ${chars(compacted)} chars  (${Math.round((1 - chars(compacted) / chars(messages)) * 100)}% smaller)`);
console.log(`recency    ${rec}/${total}   ${chars(truncated)} chars  (same budget as jev)`);
// Both arms agreeing proves nothing if the control is already wrong: the
// questions or the transcript would be at fault, not compaction.
if (full < total) {
  console.log(`\nINVALID: the control itself only answered ${full}/${total}. Fix the questions or the transcript before reading anything into the compacted arm.`);
  process.exitCode = 1;
} else if (jev < full) {
  console.log(`\nFAIL: compaction lost ${full - jev} answer(s) the full transcript had.`);
  process.exitCode = 1;
} else if (jev <= rec) {
  // The whole claim is that asking the model beats deleting by age. If the
  // naive baseline matches it, the model is not earning its cost and the
  // benchmark must not report success.
  console.log(`\nFAIL: recency truncation scored ${rec}/${total} against compaction's ${jev}/${total} at a comparable size. Nothing here justifies the extra call.`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: compaction preserved every answer (${jev}/${total}) and beat recency truncation (${rec}/${total}) at a comparable size.`);
}
