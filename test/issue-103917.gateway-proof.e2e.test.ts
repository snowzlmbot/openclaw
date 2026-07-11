import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

type ChatMessage = { role?: string; content?: unknown };
type CapturedRequest = { messages: ChatMessage[]; toolNames: string[] };

const instances: OpenClawTestInstance[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("issue 103917 real Gateway containment", () => {
  it("keeps the same Gateway alive when coder workspace deletion reaches sessions_spawn", async () => {
    const proofDir = path.resolve(
      process.env.ISSUE103917_PROOF_DIR ?? ".artifacts/issue-103917",
    );
    await fs.mkdir(proofDir, { recursive: true });

    const fakeProvider = await startFakeProvider();
    servers.push(fakeProvider);
    const instance = await createOpenClawTestInstance({
      name: "issue-103917-gateway-proof",
      env: {
        ISSUE103917_FAKE_API_KEY: "test-only-value",
        OPENCLAW_TEST_FAST: "1",
      },
    });
    instances.push(instance);

    const modelRef = "proof/issue-103917-model";
    const mainWorkspace = path.join(instance.homeDir, "workspace");
    const coderWorkspace = path.join(mainWorkspace, "coder");
    await instance.state.writeConfig({
      gateway: {
        mode: "local",
        port: instance.port,
        bind: "loopback",
        auth: { mode: "token", token: instance.gatewayToken },
        controlUi: { enabled: false },
      },
      models: {
        mode: "merge",
        providers: {
          proof: {
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: "ISSUE103917_FAKE_API_KEY" },
            baseUrl: fakeProvider.baseUrl,
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "issue-103917-model",
                name: "Issue 103917 proof model",
                api: "openai-completions",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 1_024,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: modelRef, fallbacks: [] },
          workspace: mainWorkspace,
          skipBootstrap: true,
          timeoutSeconds: 60,
          subagents: { maxSpawnDepth: 1, runTimeoutSeconds: 30 },
        },
        list: [
          {
            id: "main",
            default: true,
            workspace: mainWorkspace,
            model: modelRef,
            subagents: { allowAgents: ["coder"] },
          },
          { id: "coder", workspace: coderWorkspace, model: modelRef },
        ],
      },
      plugins: { enabled: false },
      skills: { allowBundled: [] },
      tools: { allow: ["sessions_spawn"] },
    });

    let gatewayPid: number | undefined;
    const attempts: Array<{ code: number | null; label: string }> = [];
    try {
      await instance.startGateway();
      gatewayPid = instance.child?.pid;
      expect(gatewayPid).toBeTypeOf("number");
      expect(await health(instance.port)).toBe(true);

      const warmup = await instance.cli(
        [
          "agent",
          "--agent",
          "coder",
          "--session-id",
          "issue-103917-warmup",
          "--message",
          "ISSUE103917_WARMUP",
        ],
        { timeoutMs: 120_000 },
      );
      expect(warmup.code, warmup.stderr).toBe(0);
      expect(warmup.stdout).toContain("coder warmup complete");

      await fs.rm(coderWorkspace, { force: true, recursive: true });
      const attested = await runSpawnAttempt(instance, "ATTESTED_DELETE");
      attempts.push({ code: attested.code, label: "attested-delete" });
      expect(attested.code, attested.stderr).toBe(0);
      await delay(500);
      expect(instance.child?.pid).toBe(gatewayPid);
      expect(instance.child?.exitCode).toBeNull();
      expect(await health(instance.port)).toBe(true);

      for (let index = 1; index <= 5; index += 1) {
        await fs.mkdir(coderWorkspace, { recursive: true });
        const timer = setInterval(() => {
          void fs.rm(coderWorkspace, { force: true, recursive: true });
        }, 2);
        try {
          const result = await runSpawnAttempt(instance, `RACE_${index}`);
          attempts.push({ code: result.code, label: `race-${index}` });
          expect(result.code, result.stderr).toBe(0);
        } finally {
          clearInterval(timer);
        }
        await delay(250);
        expect(instance.child?.pid).toBe(gatewayPid);
        expect(instance.child?.exitCode).toBeNull();
        expect(await health(instance.port)).toBe(true);
      }

      const rpc = await instance.cli(["gateway", "status", "--require-rpc", "--json"], {
        timeoutMs: 30_000,
      });
      expect(rpc.code, rpc.stderr).toBe(0);

      const logs = sanitize(instance.logs(), instance.homeDir);
      expect(logs).not.toContain("Unhandled promise rejection");
      const result = {
        platform: process.platform,
        node: process.version,
        gatewayPid,
        pidStable: instance.child?.pid === gatewayPid,
        healthyAfter: await health(instance.port),
        authenticatedRpcAfter: rpc.code === 0,
        attempts,
        providerRequests: fakeProvider.requests.length,
        toolResultMessages: fakeProvider.toolResults.map((value) =>
          sanitize(value, instance.homeDir),
        ),
        unhandledPromiseRejection: logs.includes("Unhandled promise rejection"),
      };
      await Promise.all([
        fs.writeFile(
          path.join(proofDir, "full-gateway.json"),
          `${JSON.stringify(result, null, 2)}\n`,
        ),
        fs.writeFile(path.join(proofDir, "gateway-process.log"), logs),
      ]);
    } finally {
      if (gatewayPid && instance.child) {
        const logs = sanitize(instance.logs(), instance.homeDir);
        await fs.writeFile(path.join(proofDir, "gateway-process-final.log"), logs);
      }
    }
  }, 240_000);
});

async function runSpawnAttempt(instance: OpenClawTestInstance, label: string) {
  return await instance.cli(
    [
      "agent",
      "--agent",
      "main",
      "--session-id",
      `issue-103917-${label.toLowerCase()}`,
      "--message",
      `ISSUE103917_SPAWN_${label}`,
    ],
    { timeoutMs: 120_000 },
  );
}

async function health(port: number): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  return response.ok;
}

function sanitize(value: string, homeDir: string): string {
  return value
    .replaceAll(homeDir, "<synthetic-home>")
    .replaceAll(/Bearer\s+\S+/giu, "Bearer <redacted>");
}

async function startFakeProvider() {
  const requests: CapturedRequest[] = [];
  const toolResults: string[] = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response, requests, toolResults);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake provider did not expose a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}/v1`,
    requests,
    toolResults,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRequest[],
  toolResults: string[],
) {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "issue-103917-model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected proof request" } }));
    return;
  }

  const payload = JSON.parse(await readBody(request)) as {
    messages?: ChatMessage[];
    tools?: Array<{ function?: { name?: string } }>;
  };
  const messages = payload.messages ?? [];
  requests.push({
    messages,
    toolNames: (payload.tools ?? []).map((tool) => tool.function?.name ?? "unknown"),
  });
  const toolMessage = messages.findLast((message) => message.role === "tool");
  if (toolMessage) {
    toolResults.push(messageText(toolMessage));
    return sendText(response, "spawn result contained; gateway still serving");
  }

  const prompt = messages.map(messageText).join("\n");
  if (prompt.includes("ISSUE103917_WARMUP")) {
    return sendText(response, "coder warmup complete");
  }
  if (prompt.includes("ISSUE103917_CHILD_")) {
    return sendText(response, "child completed");
  }
  const match = prompt.match(/ISSUE103917_SPAWN_([A-Z0-9_]+)/u);
  if (match) {
    return sendToolCall(response, match[1] ?? "UNKNOWN");
  }
  return sendText(response, "proof provider fallback");
}

function sendToolCall(response: ServerResponse, label: string) {
  startSse(response);
  writeSse(response, {
    id: `chatcmpl-issue-103917-${label}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "issue-103917-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_issue_103917_${label}`,
              type: "function",
              function: {
                name: "sessions_spawn",
                arguments: JSON.stringify({
                  agentId: "coder",
                  cleanup: "delete",
                  mode: "run",
                  runtime: "subagent",
                  task: `ISSUE103917_CHILD_${label}`,
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  writeSse(response, {
    id: `chatcmpl-issue-103917-${label}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "issue-103917-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  response.end("data: [DONE]\n\n");
}

function sendText(response: ServerResponse, content: string) {
  startSse(response);
  writeSse(response, {
    id: "chatcmpl-issue-103917-text",
    object: "chat.completion.chunk",
    created: 1,
    model: "issue-103917-model",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
  writeSse(response, {
    id: "chatcmpl-issue-103917-text",
    object: "chat.completion.chunk",
    created: 1,
    model: "issue-103917-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  response.end("data: [DONE]\n\n");
}

function startSse(response: ServerResponse) {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
}

function writeSse(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && "text" in part) {
        return String(part.text);
      }
      return "";
    })
    .join("\n");
}
