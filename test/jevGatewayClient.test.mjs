import assert from "node:assert/strict";
import test from "node:test";
import { VercelGatewayJevClient, fromGatewayAnswers, toGatewayQuestions } from "../lib/jevGatewayClient.mjs";

test("toGatewayQuestions translates TypeSafe's noul type to the gateway's boolean type", () => {
  const translated = toGatewayQuestions({ t1: { type: "noul", instructions: "Is it needed?" } });
  assert.equal(translated.t1.type, "boolean");
  assert.equal(translated.t1.instructions, "Is it needed?");
});

test("toGatewayQuestions carries criteria through untouched", () => {
  // The gateway's boolean question takes the same criteria shape as a noul
  // one; dropping them here would silently undo the question framing that
  // makes JEV's answers discriminate.
  const criteria = { true: "still load-bearing", false: "superseded" };
  const translated = toGatewayQuestions({ "t1:call": { type: "noul", instructions: "Needed?", criteria } });
  assert.deepEqual(translated["t1:call"].criteria, criteria);
});

test("fromGatewayAnswers normalizes {type, probability} answers to {noul}", () => {
  const normalized = fromGatewayAnswers({ t1: { type: "boolean", probability: 0.42 } });
  assert.equal(normalized.t1.noul, 0.42);
});

test("fromGatewayAnswers rejects a malformed answer", () => {
  assert.throws(() => fromGatewayAnswers({ t1: { type: "boolean" } }), /Invalid Jev gateway answer/);
});

test("VercelGatewayJevClient.ask sends boolean-typed questions and returns noul-normalized answers with snake_case usage", async () => {
  let capturedArgs;
  const fakeEvaluate = async (args) => {
    capturedArgs = args;
    return {
      answers: { "t1:call": { type: "boolean", probability: 0.8 }, "t1:result": { type: "boolean", probability: 0.3 } },
      usage: { inputTokens: 120, outputTokens: 15 }
    };
  };
  const client = new VercelGatewayJevClient({
    model: "typesafe-ai/jev",
    evaluate: fakeEvaluate,
    gatewayModel: (id) => ({ resolved: id })
  });

  const response = await client.ask("state", {
    "t1:call": { type: "noul", instructions: "keep the call?" },
    "t1:result": { type: "noul", instructions: "keep the result?" }
  });

  assert.deepEqual(capturedArgs.model, { resolved: "typesafe-ai/jev" });
  assert.equal(capturedArgs.questions["t1:call"].type, "boolean");
  assert.equal(response.answers["t1:call"].noul, 0.8);
  assert.equal(response.answers["t1:result"].noul, 0.3);
  assert.deepEqual(response.usage, { input_tokens: 120, output_tokens: 15 });
});
