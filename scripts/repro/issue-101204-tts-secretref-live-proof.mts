import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { connectGatewayClient, disconnectGatewayClient } from "../../src/gateway/test-helpers.e2e.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.js";

function sanitize(text: string, replacements: Record<string, string | undefined>): string {
  let next = text;
  for (const [raw, label] of Object.entries(replacements)) {
    if (!raw) continue;
    next = next.split(raw).join(label ?? "[REDACTED]");
  }
  return next
    .replace(/gateway-issue-101204-tts-secretref-[0-9a-f-]+/giu, "[REDACTED:gateway_token]")
    .replace(/token-issue-101204-tts-secretref-[0-9a-f-]+/giu, "[REDACTED:hook_token]")
    .replace(/\/tmp\/[^\s"]+/g, "[REDACTED:tmp_path]")
    .replace(/127\.0\.0\.1:\d+/gu, "127.0.0.1:[PORT]");
}

function assertContains(label: string, haystack: string, needle: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} did not contain expected marker: ${needle}`);
  }
}

const inst = await createOpenClawTestInstance({
  name: "issue-101204-tts-secretref",
  config: {
    messages: {
      tts: {
        auto: "always",
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
            speakerVoiceId: "proof-voice-id",
          },
        },
      },
    },
  },
  env: {
    ELEVENLABS_API_KEY: undefined,
    OPENCLAW_SKIP_PROVIDERS: "0",
  },
  startTimeoutMs: 90_000,
});

let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
try {
  await inst.startGateway();
  const startupLogs = sanitize(inst.logs(), {
    [inst.gatewayToken]: "[REDACTED:gateway_token]",
    [inst.hookToken]: "[REDACTED:hook_token]",
    [inst.homeDir]: "[REDACTED:home_dir]",
    [inst.stateDir]: "[REDACTED:state_dir]",
    [inst.configPath]: "[REDACTED:config_path]",
  });

  assertContains("startup log", startupLogs, "SECRETS_REF_UNAVAILABLE_OPTIONAL");
  assertContains("startup log", startupLogs, "messages.tts.providers.elevenlabs.apiKey");
  assertContains("startup log", startupLogs, 'Environment variable "ELEVENLABS_API_KEY" is missing or empty.');

  console.log("## live-startup-proof");
  console.log("Gateway started with missing optional ELEVENLABS_API_KEY SecretRef.");
  console.log(startupLogs.split("\n").filter((line) =>
    line.includes("SECRETS_REF_UNAVAILABLE_OPTIONAL") ||
    line.includes("Gateway") ||
    line.includes("listening") ||
    line.includes("startup"),
  ).join("\n"));

  client = await connectGatewayClient({
    url: inst.url,
    token: inst.gatewayToken,
    clientName: GATEWAY_CLIENT_NAMES.TEST,
    clientDisplayName: "issue-101204-live-proof",
    clientVersion: "proof",
    platform: "linux",
    mode: GATEWAY_CLIENT_MODES.TEST,
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    connectChallengeTimeoutMs: 0,
    requestTimeoutMs: 12_000,
  });

  try {
    await client.request("tts.speak", { text: "issue 101204 live proof" }, { timeoutMs: 12_000 });
    throw new Error("tts.speak unexpectedly succeeded without ELEVENLABS_API_KEY");
  } catch (error) {
    const message = sanitize(error instanceof Error ? error.message : String(error), {
      [inst.gatewayToken]: "[REDACTED:gateway_token]",
    });
    if (!/tts|speech|provider|api key|configured|unavailable/iu.test(message)) {
      throw new Error(`tts.speak failed with an unexpected message: ${message}`);
    }
    console.log("## live-tts-request-proof");
    console.log("tts.speak failed locally while Gateway stayed up:");
    console.log(message);
  }

  console.log("## result");
  console.log("PASS: missing optional TTS SecretRef degraded startup and localized TTS failure.");
} finally {
  if (client) {
    await disconnectGatewayClient(client).catch(() => undefined);
  }
  await inst.cleanup();
}
