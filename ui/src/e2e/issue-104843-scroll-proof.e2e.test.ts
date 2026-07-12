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
} from "../test-helpers/control-ui-e2e.ts";

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
  chunk: number;
  clientHeight: number;
  distanceFromBottom: number;
  elapsedMs: number;
  scrollHeight: number;
  scrollTop: number;
  violation: boolean;
};

type ProofResult = {
  candidate: string;
  candidateSha: string;
  chunks: number;
  firstViolation: ScrollSample | null;
  longestViolationFrames: number;
  maxDistanceFromBottom: number;
  maxScrollHeight: number;
  sampleCount: number;
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
            samples: ScrollSample[];
            sha: string;
            startedAt: number;
          };
        }
      ).issue104843Proof = {
        active: false,
        candidate,
        chunk: 0,
        samples: [],
        sha,
        startedAt: performance.now(),
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
          samples: ScrollSample[];
          sha: string;
          startedAt: number;
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
        const entry: ScrollSample = {
          active: proof.active,
          chunk: proof.chunk,
          clientHeight: thread.clientHeight,
          distanceFromBottom,
          elapsedMs,
          scrollHeight: thread.scrollHeight,
          scrollTop: Math.round(thread.scrollTop),
          violation,
        };
        proof.samples.push(entry);
        overlay.dataset.violation = String(violation);
        overlay.textContent = [
          "OpenClaw #104843 browser proof",
          `candidate: ${proof.candidate}`,
          `sha: ${proof.sha.slice(0, 12)}`,
          "Auto-scroll: Always",
          `stream active: ${proof.active}`,
          `chunk: ${proof.chunk}`,
          `scrollTop: ${entry.scrollTop}`,
          `scrollHeight: ${entry.scrollHeight}`,
          `clientHeight: ${entry.clientHeight}`,
          `distanceFromBottom: ${entry.distanceFromBottom}`,
          `violation: ${entry.violation}`,
        ].join("\n");
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function emitHighFrequencyStream(page: Page, runId: string): Promise<number> {
  return await page.evaluate(
    async ({ id }) => {
      const exposed = window as Window & {
        openclawControlUiE2eGateway?: {
          emit: (event: string, payload: unknown) => void;
        };
        issue104843Proof?: {
          active: boolean;
          candidate: string;
          chunk: number;
          samples: ScrollSample[];
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
      proof.startedAt = performance.now();
      let accumulated = "# High-frequency streaming proof\n\n";
      const chunks = 480;
      for (let chunk = 1; chunk <= chunks; chunk += 1) {
        proof.chunk = chunk;
        const section = Math.ceil(chunk / 8);
        accumulated +=
          chunk % 8 === 1
            ? `\n## Stream section ${section}\n\n`
            : `token-${chunk} preserves continuous streamed output and layout growth. `;
        if (chunk % 24 === 0) {
          accumulated += `\n\n\`\`\`text\nlate-layout-${chunk}\n${"0123456789 ".repeat(20)}\n\`\`\`\n`;
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
        await new Promise<void>((resolve) => window.setTimeout(resolve, 2));
      }
      proof.active = false;
      return chunks;
    },
    { id: runId },
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

  it("keeps Auto-scroll Always pinned during a high-frequency streamed response", async () => {
    const baseTs = Date.now() - 500_000;
    const historyMessages = Array.from({ length: 70 }, (_, index) => ({
      content: [
        {
          text: `History message ${index + 1}\n${"Prior transcript evidence line.\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, { historyMessages });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText("History message 70").waitFor({ timeout: 15_000 });
    await configureAlwaysAutoScroll(page);
    await installEvidenceOverlay(page);
    await startScrollSampling(page);

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
      .fill("Run the deterministic high-frequency streaming scroll proof.");
    await page.getByRole("button", { name: "Send message" }).click();
    const sendRequest = await gateway.waitForRequest("chat.send");
    const params = sendRequest.params as Record<string, unknown>;
    const runId = String(params.idempotencyKey ?? "");
    expect(runId).not.toBe("");

    const chunks = await emitHighFrequencyStream(page, runId);
    await page.waitForTimeout(500);
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
    let currentViolationFrames = 0;
    let longestViolationFrames = 0;
    for (const sample of activeSamples) {
      currentViolationFrames = sample.violation ? currentViolationFrames + 1 : 0;
      longestViolationFrames = Math.max(longestViolationFrames, currentViolationFrames);
    }
    const result: ProofResult = {
      candidate: candidateLabel,
      candidateSha,
      chunks,
      firstViolation: violations[0] ?? null,
      longestViolationFrames,
      maxDistanceFromBottom: Math.max(
        0,
        ...activeSamples.map((sample) => sample.distanceFromBottom),
      ),
      maxScrollHeight: Math.max(0, ...activeSamples.map((sample) => sample.scrollHeight)),
      sampleCount: samples.length,
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
        `- Streamed chunks: ${chunks}`,
        `- Animation-frame samples: ${samples.length}`,
        `- Maximum distance from bottom while streaming: ${result.maxDistanceFromBottom}px`,
        `- Violating frames (>240px from bottom in Always mode): ${result.violationCount}`,
        `- Longest consecutive violation: ${result.longestViolationFrames} frames`,
        `- First violation: \`${JSON.stringify(result.firstViolation)}\``,
        "",
        "The Playwright video, final screenshot, complete frame samples, and Vitest output are uploaded by the workflow.",
      ].join("\n"),
    );

    expect(
      result.longestViolationFrames,
      `Auto-scroll Always stayed more than 240px from the newest content for ${result.longestViolationFrames} consecutive frames and drifted by up to ${result.maxDistanceFromBottom}px`,
    ).toBeLessThan(6);
  }, 90_000);
});
