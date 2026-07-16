import fs from "node:fs";
import path from "node:path";

const checkout = path.resolve(process.argv[2] ?? ".");
const testPath = path.join(
  checkout,
  "src/agents/embedded-agent-runner/run.incomplete-turn.test.ts",
);
let source = fs.readFileSync(testPath, "utf8");

const constantAnchor = `const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";`;
const continuationConstant = `${constantAnchor}
const TOOL_USE_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";`;

if (!source.includes(constantAnchor)) {
  throw new Error(`Missing constant anchor in ${testPath}`);
}
if (!source.includes("TOOL_USE_TERMINAL_CONTINUATION_INSTRUCTION")) {
  source = source.replace(constantAnchor, continuationConstant);
}

const testAnchor =
  '  it("returns NO_REPLY without retrying reasoning-only assistant turns when silence is allowed", async () => {';
const proofTest = `  it("issue 108738: continues after settled tools instead of ending without final text", async () => {
    const toolUseAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "toolCall", id: "tool_1", name: "write", arguments: { path: "note.txt" } }],
    } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
    const settledToolResults = [
      { role: "toolResult", toolCallId: "tool_1", toolName: "write", isError: false },
    ] as unknown as EmbeddedRunAttemptResult["messagesSnapshot"];
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      markUserMessagePersisted(attemptParams);
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "write", meta: "path=note.txt" }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: settledToolResults,
        lastAssistant: toolUseAssistant,
        currentAttemptAssistant: toolUseAssistant,
      });
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["Write completed. Here is the final answer."] }),
    );
    mockedBuildEmbeddedRunPayloads
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ text: "Write completed. Here is the final answer." }]);

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-issue-108738-tool-use-terminal-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("Write completed. Here is the final answer.");
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toBe(TOOL_USE_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(secondCall.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCall.skipPreparedUserTurnMessage).toBe(true);
    expectWarnMessageWith("tool-use terminal turn lacked a final answer");
  });

`;

if (!source.includes(testAnchor)) {
  throw new Error(`Missing test anchor in ${testPath}`);
}
if (!source.includes("issue 108738: continues after settled tools")) {
  source = source.replace(testAnchor, `${proofTest}${testAnchor}`);
}

fs.writeFileSync(testPath, source);
console.log(`Injected issue #108738 regression into ${testPath}`);
