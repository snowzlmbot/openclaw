// Browser evidence harness for https://github.com/openclaw/openclaw/issues/104843.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "./test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const describeControlUiE2e = chromiumAvailable ? describe : describe.skip;
const artifactDir = path.resolve(
  process.env.OPENCLAW_ISSUE_104843_ARTIFACT_DIR ??
    ".artifacts/issue-104843-scroll-proof/unknown-candidate",
);
const candidateLabel = process.env.OPENCLAW_ISSUE_104843_CANDIDATE ?? "unknown-candidate";
const candidateSha = process.env.OPENCLAW_ISSUE_104843_SHA ?? "unknown-sha";

type ScrollSample = {
  active: boolean;
  catastrophicJump: boolean;
  chunk: number;
  clientHeight: number;
  distanceFromBottom: number;
  elapsedMs: number;
  scenario: string;
  scrollHeight: number;
  scrollTop: number;
  threadNodeId: number;
  violation: boolean;
};

type ProofResult = {
  audioAttachmentObserved: boolean;
  audioMetadataObserved: boolean;
  candidate: string;
  candidateSha: string;
  catastrophicJumpCount: number;
  chunks: number;
  firstCatastrophicJump: ScrollSample | null;
  firstViolation: ScrollSample | null;
  longestViolationFrames: number;
  maxDistanceFromBottom: number;
  maxScrollHeight: number;
  sampleCount: number;
  scenarios: string[];
  violationCount: number;
};

let server: ControlUiE2eServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;

async function configureAlwaysAutoScroll(page: Page): Promise<void> {
  await page.locator(".chat-settings-chip").click();
  const toggle = page.locator('[data-chat-auto-scroll-toggle="true"]');
  await toggle.waitFor({ state: "visible", timeout: 10_000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await toggle.getAttribute("data-chat-auto-scroll-mode")) === "always") {
      return;
    }
    await toggle.click();
  }
  expect(await toggle.getAttribute("data-chat-auto-scroll-mode")).toBe("always");
}

async function installEvidenceOverlay(page: Page): Promise<void> {
  await page.evaluate(
    ({ candidate, sha }) => {
      const style = document.createElement("style");
      style.textContent = `
        #issue-104843-proof {
          position: fixed;
          inset: 12px 12px auto auto;
          z-index: 2147483647;
          width: 370px;
          padding: 12px 14px;
          border: 2px solid #0ea5e9;
          border-radius: 6px;
          background: rgba(2, 6, 23, 0.94);
          color: #f8fafc;
          font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: pre-wrap;
          pointer-events: none;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        }
        #issue-104843-proof[data-violation="true"] {
          border-color: #ef4444;
          background: rgba(69, 10, 10, 0.96);
        }
      `;
      document.head.append(style);
      const overlay = document.createElement("div");
      overlay.id = "issue-104843-proof";
      overlay.dataset.violation = "false";
      overlay.textContent = [
        "OpenClaw #104843 browser proof",
        `candidate: ${candidate}`,
        `sha: ${sha.slice(0, 12)}`,
        "waiting for stream...",
      ].join("\n");
      document.body.append(overlay);
      (
        window as Window & {
          issue104843Proof?: {
            active: boolean;
            candidate: string;
            chunk: number;
            nextThreadNodeId: number;
            previousDistanceFromBottom: number;
            samples: ScrollSample[];
            scenario: string;
            sha: string;
            startedAt: number;
            threadNodeIds: WeakMap<HTMLElement, number>;
          };
        }
      ).issue104843Proof = {
        active: false,
        candidate,
        chunk: 0,
        nextThreadNodeId: 1,
        previousDistanceFromBottom: 0,
        samples: [],
        scenario: "waiting",
        sha,
        startedAt: performance.now(),
        threadNodeIds: new WeakMap<HTMLElement, number>(),
      };
    },
    { candidate: candidateLabel, sha: candidateSha },
  );
}

async function startScrollSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const proof = (
      window as Window & {
        issue104843Proof?: {
          active: boolean;
          candidate: string;
          chunk: number;
          nextThreadNodeId: number;
          previousDistanceFromBottom: number;
          samples: ScrollSample[];
          scenario: string;
          sha: string;
          startedAt: number;
          threadNodeIds: WeakMap<HTMLElement, number>;
        };
      }
    ).issue104843Proof;
    if (!proof) {
      throw new Error("proof overlay state is missing");
    }
    const sample = () => {
      const thread = document.querySelector<HTMLElement>(".chat-thread");
      const overlay = document.querySelector<HTMLElement>("#issue-104843-proof");
      if (thread && overlay) {
        const distanceFromBottom = Math.max(
          0,
          Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight),
        );
        const elapsedMs = Math.round(performance.now() - proof.startedAt);
        const violation =
          proof.active && thread.scrollHeight > thread.clientHeight * 2 && distanceFromBottom > 240;
        const catastrophicJump =
          proof.active &&
          proof.previousDistanceFromBottom <= 8 &&
          thread.scrollHeight > thread.clientHeight * 3 &&
          thread.scrollTop <= 2;
        let threadNodeId = proof.threadNodeIds.get(thread);
        if (!threadNodeId) {
          threadNodeId = proof.nextThreadNodeId;
          proof.nextThreadNodeId += 1;
          proof.threadNodeIds.set(thread, threadNodeId);
        }
        const entry: ScrollSample = {
          active: proof.active,
          catastrophicJump,
          chunk: proof.chunk,
          clientHeight: thread.clientHeight,
          distanceFromBottom,
          elapsedMs,
          scenario: proof.scenario,
          scrollHeight: thread.scrollHeight,
          scrollTop: Math.round(thread.scrollTop),
          threadNodeId,
          violation,
        };
        proof.samples.push(entry);
        proof.previousDistanceFromBottom = distanceFromBottom;
        overlay.dataset.violation = String(violation || catastrophicJump);
        overlay.textContent = [
          "OpenClaw #104843 browser proof",
          `candidate: ${proof.candidate}`,
          `sha: ${proof.sha.slice(0, 12)}`,
          "Auto-scroll: Always",
          `scenario: ${proof.scenario}`,
          `stream active: ${proof.active}`,
          `chunk: ${proof.chunk}`,
          `thread node: ${entry.threadNodeId}`,
          `scrollTop: ${entry.scrollTop}`,
          `scrollHeight: ${entry.scrollHeight}`,
          `clientHeight: ${entry.clientHeight}`,
          `distanceFromBottom: ${entry.distanceFromBottom}`,
          `catastrophic jump: ${entry.catastrophicJump}`,
          `violation: ${entry.violation}`,
        ].join("\n");
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function emitScenarioStream(
  page: Page,
  params: { chunks: number; intervalsMs: number[]; runId: string; scenario: string },
): Promise<string> {
  return await page.evaluate(
    async ({ chunks, id, intervalsMs, scenario }) => {
      const exposed = window as Window & {
        openclawControlUiE2eGateway?: {
          emit: (event: string, payload: unknown) => void;
        };
        issue104843Proof?: {
          active: boolean;
          candidate: string;
          chunk: number;
          previousDistanceFromBottom: number;
          samples: ScrollSample[];
          scenario: string;
          sha: string;
          startedAt: number;
        };
      };
      const gateway = exposed.openclawControlUiE2eGateway;
      const proof = exposed.issue104843Proof;
      if (!gateway || !proof) {
        throw new Error("mock Gateway or proof state is missing");
      }

      proof.active = true;
      proof.scenario = scenario;
      proof.chunk = 0;
      proof.previousDistanceFromBottom = 0;
      proof.startedAt = performance.now();
      let accumulated = `# ${scenario} streaming proof\n\n`;
      for (let chunk = 1; chunk <= chunks; chunk += 1) {
        proof.chunk = chunk;
        const section = Math.ceil(chunk / 8);
        accumulated +=
          chunk % 8 === 1
            ? `\n## Stream section ${section}\n\n`
            : `token-${chunk} preserves continuous streamed output and layout growth. `;
        if (chunk % 48 === 1) {
          accumulated += `\n\n\`\`\`text\nopen-fence-${chunk}\n${"0123456789 ".repeat(20)}\n`;
        } else if (chunk % 48 === 24) {
          accumulated += "\n```\n";
        }
        if (chunk % 37 === 0) {
          accumulated += "\n| column a | column b |\n| --- | --- |\n| alpha | beta |\n";
        }
        gateway.emit("chat", {
          deltaText: accumulated,
          message: {
            content: [{ text: accumulated, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId: id,
          sessionKey: "main",
          state: "delta",
        });
        const intervalMs = intervalsMs[(chunk - 1) % intervalsMs.length] ?? 0;
        await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs));
      }
      return accumulated;
    },
    {
      chunks: params.chunks,
      id: params.runId,
      intervalsMs: params.intervalsMs,
      scenario: params.scenario,
    },
  );
}

function createSilentWav(): Buffer {
  const sampleRate = 8_000;
  const sampleCount = 2_000;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function emitStringChatFinal(page: Page, runId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, finalText }) => {
      const gateway = (
        window as Window & {
          openclawControlUiE2eGateway?: {
            emit: (event: string, payload: unknown) => void;
          };
        }
      ).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("mock Gateway is missing");
      }
      gateway.emit("chat", {
        message: {
          content: finalText,
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: id,
        sessionKey: "main",
        state: "final",
      });
    },
    { finalText: text, id: runId },
  );
}

describeControlUiE2e("issue #104843 WebChat streaming scroll browser proof", () => {
  beforeAll(async () => {
    await fs.mkdir(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 720, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    page = await context.newPage();
  });

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("keeps Auto-scroll Always pinned across burst, retry-boundary, and TTS-shaped streams", async () => {
    const baseTs = Date.now() - 500_000;
    const historyMessages = Array.from({ length: 140 }, (_, index) => ({
      content: [
        {
          text: `History message ${index + 1}\n${"Prior transcript evidence line.\n".repeat(6)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, { historyMessages });
    const audioUrl = `${server.baseUrl}issue-104843-tone.wav`;
    await page.route("**/issue-104843-tone.wav", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 450));
      await route.fulfill({ body: createSilentWav(), contentType: "audio/wav", status: 200 });
    });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText("History message 140").waitFor({ timeout: 15_000 });
    await configureAlwaysAutoScroll(page);
    await installEvidenceOverlay(page);
    await startScrollSampling(page);

    const scenarios = [
      { chunks: 480, intervalsMs: [2], name: "raf-burst", ttsShapedFinal: false },
      {
        chunks: 176,
        intervalsMs: [0, 1, 4, 15, 17, 33, 80, 119, 121, 149, 151],
        name: "retry-boundaries",
        ttsShapedFinal: false,
      },
      {
        chunks: 320,
        intervalsMs: [1, 4, 15, 17, 33],
        name: "tts-shaped-delayed-audio",
        ttsShapedFinal: true,
      },
    ];
    let audioAttachmentObserved = false;
    let audioMetadataObserved = false;
    let chunks = 0;
    for (const scenario of scenarios) {
      await expect
        .poll(
          () =>
            page.locator(".chat-thread").evaluate((element) => {
              const thread = element as HTMLElement;
              return Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight);
            }),
          { timeout: 15_000 },
        )
        .toBeLessThanOrEqual(4);

      await gateway.deferNext("chat.send");
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill(`Run deterministic ${scenario.name} streaming scroll proof.`);
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = sendRequest.params as Record<string, unknown>;
      const runId = String(params.idempotencyKey ?? "");
      expect(runId).not.toBe("");
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });

      const accumulated = await emitScenarioStream(page, {
        chunks: scenario.chunks,
        intervalsMs: scenario.intervalsMs,
        runId,
        scenario: scenario.name,
      });
      chunks += scenario.chunks;
      const finalText = scenario.ttsShapedFinal
        ? `${accumulated}\n\nTTS-shaped delayed audio attachment.\nMEDIA:${audioUrl}\n[[audio_as_voice]]`
        : `${accumulated}\n\nFinalized ${scenario.name}.`;
      if (scenario.ttsShapedFinal) {
        await emitStringChatFinal(page, runId, finalText);
        audioAttachmentObserved = await page
          .locator("audio")
          .last()
          .waitFor({ state: "attached", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (audioAttachmentObserved) {
          audioMetadataObserved = await expect
            .poll(
              () =>
                page
                  .locator("audio")
                  .last()
                  .evaluate((element) => (element as HTMLAudioElement).readyState),
              { timeout: 10_000 },
            )
            .toBeGreaterThanOrEqual(1)
            .then(() => true)
            .catch(() => false);
        }
        await page.waitForTimeout(1_000);
      } else {
        await gateway.emitChatFinal({ runId, text: finalText });
        await page.waitForTimeout(350);
      }
      await page.evaluate((scenarioName) => {
        const proof = (
          window as Window & {
            issue104843Proof?: { active: boolean; scenario: string };
          }
        ).issue104843Proof;
        if (proof) {
          proof.active = false;
          proof.scenario = `${scenarioName}:complete`;
        }
      }, scenario.name);
    }

    await page.screenshot({ fullPage: true, path: path.join(artifactDir, "final-state.png") });

    const samples = await page.evaluate(() => {
      return (
        (
          window as Window & {
            issue104843Proof?: { samples: ScrollSample[] };
          }
        ).issue104843Proof?.samples ?? []
      );
    });
    const activeSamples = samples.filter((sample) => sample.active);
    const violations = activeSamples.filter((sample) => sample.violation);
    const catastrophicJumps = activeSamples.filter((sample) => sample.catastrophicJump);
    let currentViolationFrames = 0;
    let longestViolationFrames = 0;
    for (const sample of activeSamples) {
      currentViolationFrames = sample.violation ? currentViolationFrames + 1 : 0;
      longestViolationFrames = Math.max(longestViolationFrames, currentViolationFrames);
    }
    const result: ProofResult = {
      audioAttachmentObserved,
      audioMetadataObserved,
      candidate: candidateLabel,
      candidateSha,
      catastrophicJumpCount: catastrophicJumps.length,
      chunks,
      firstCatastrophicJump: catastrophicJumps[0] ?? null,
      firstViolation: violations[0] ?? null,
      longestViolationFrames,
      maxDistanceFromBottom: Math.max(
        0,
        ...activeSamples.map((sample) => sample.distanceFromBottom),
      ),
      maxScrollHeight: Math.max(0, ...activeSamples.map((sample) => sample.scrollHeight)),
      sampleCount: samples.length,
      scenarios: scenarios.map((scenario) => scenario.name),
      violationCount: violations.length,
    };
    await fs.writeFile(
      path.join(artifactDir, "scroll-samples.json"),
      JSON.stringify(samples, null, 2),
    );
    await fs.writeFile(
      path.join(artifactDir, "proof-result.json"),
      JSON.stringify(result, null, 2),
    );
    await fs.writeFile(
      path.join(artifactDir, "summary.md"),
      [
        `# OpenClaw #104843 browser proof: ${candidateLabel}`,
        "",
        `- Candidate SHA: \`${candidateSha}\``,
        `- Scenarios: ${result.scenarios.join(", ")}`,
        `- Streamed chunks: ${chunks}`,
        `- Delayed audio element observed: ${result.audioAttachmentObserved}`,
        `- Delayed audio metadata loaded: ${result.audioMetadataObserved}`,
        `- Animation-frame samples: ${samples.length}`,
        `- Maximum distance from bottom while streaming: ${result.maxDistanceFromBottom}px`,
        `- Catastrophic bottom-to-top frames: ${result.catastrophicJumpCount}`,
        `- First catastrophic jump: \`${JSON.stringify(result.firstCatastrophicJump)}\``,
        `- Violating frames (>240px from bottom in Always mode): ${result.violationCount}`,
        `- Longest consecutive violation: ${result.longestViolationFrames} frames`,
        `- First violation: \`${JSON.stringify(result.firstViolation)}\``,
        "",
        "The Playwright video, final screenshot, complete frame samples, and Vitest output are uploaded by the workflow.",
      ].join("\n"),
    );

    expect(audioAttachmentObserved, "TTS-shaped final did not render an audio element").toBe(true);
    expect(audioMetadataObserved, "TTS-shaped audio did not reach loaded metadata state").toBe(
      true,
    );
    expect(
      result.catastrophicJumpCount,
      `Auto-scroll Always painted ${result.catastrophicJumpCount} bottom-to-top jumps`,
    ).toBe(0);
    expect(
      result.longestViolationFrames,
      `Auto-scroll Always stayed more than 240px from the newest content for ${result.longestViolationFrames} consecutive frames and drifted by up to ${result.maxDistanceFromBottom}px`,
    ).toBeLessThan(6);
  }, 180_000);
});
