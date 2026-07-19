import assert from "node:assert/strict";
import { configureAiTransportHost } from "../../../source/packages/ai/src/host.ts";
import { streamSimpleOpenAICompletions } from "../../../source/packages/ai/src/providers/openai-completions.ts";
import { streamSimpleOpenAIResponses } from "../../../source/packages/ai/src/providers/openai-responses.ts";
import type { Context, Model } from "../../../source/packages/ai/src/types.ts";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const captured: CapturedRequest[] = [];

configureAiTransportHost({
  buildModelFetch: () => async (input, init) => {
    const request = new Request(input, init);
    captured.push({
      url: request.url,
      body: JSON.parse(await request.text()) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ error: { message: "proof capture complete" } }), {
      status: 418,
      headers: { "content-type": "application/json" },
    });
  },
});

const context: Context = {
  messages: [{ role: "user", content: "proof", timestamp: 1 }],
};

const baseModel = {
  id: "proof-model",
  name: "Proof Model",
  provider: "proof-provider",
  baseUrl: "https://proof.invalid/v1",
  reasoning: true,
  input: ["text"] as Array<"text">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

async function captureResponses(compat?: Model<"openai-responses">["compat"]) {
  const model: Model<"openai-responses"> = {
    ...baseModel,
    api: "openai-responses",
    compat,
  };
  await streamSimpleOpenAIResponses(model, context, {
    apiKey: "redacted-proof-token",
    reasoning: "xhigh",
  }).result();
  return captured.at(-1)?.body;
}

async function captureCompletions(compat?: Model<"openai-completions">["compat"]) {
  const model: Model<"openai-completions"> = {
    ...baseModel,
    api: "openai-completions",
    compat,
  };
  await streamSimpleOpenAICompletions(model, context, {
    apiKey: "redacted-proof-token",
    reasoning: "xhigh",
  }).result();
  return captured.at(-1)?.body;
}

const declaredCompat = {
  supportsReasoningEffort: true,
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
};

const declaredResponses = await captureResponses(declaredCompat);
const undeclaredResponses = await captureResponses();
const declaredCompletions = await captureCompletions(declaredCompat);
const undeclaredCompletions = await captureCompletions({ supportsReasoningEffort: true });
const optedOutCompletions = await captureCompletions({
  supportsReasoningEffort: false,
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
});

assert.equal((declaredResponses?.reasoning as { effort?: unknown })?.effort, "xhigh");
assert.equal((undeclaredResponses?.reasoning as { effort?: unknown })?.effort, "high");
assert.equal(declaredCompletions?.reasoning_effort, "xhigh");
assert.equal(undeclaredCompletions?.reasoning_effort, "high");
assert.equal(optedOutCompletions?.reasoning_effort, undefined);

const proof = {
  codeHead: process.env.PROOF_CODE_HEAD,
  upstreamBase: process.env.PROOF_UPSTREAM_BASE,
  transport: "OpenAI SDK request intercepted at the configured fetch boundary",
  assertions: {
    declaredResponses: (declaredResponses?.reasoning as { effort?: unknown })?.effort,
    undeclaredResponses: (undeclaredResponses?.reasoning as { effort?: unknown })?.effort,
    declaredCompletions: declaredCompletions?.reasoning_effort,
    undeclaredCompletions: undeclaredCompletions?.reasoning_effort,
    optedOutCompletions: optedOutCompletions?.reasoning_effort ?? "omitted",
  },
  result: "PASS",
};

console.log(JSON.stringify(proof, null, 2));
