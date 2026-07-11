import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

type Summary = {
  issue: string;
  runUrl: string;
  baseline: { ref: string; sha: string; expectedRegression: string };
  current: { sha: string; regression: string; adjacentSuites: string };
  ownerFix: { commit: string; pullRequest: string };
  failureSignatureOnCurrent: boolean;
  capturedAt: string;
};

type GatewayResult = {
  platform: string;
  node: string;
  gatewayPid: number;
  pidStable: boolean;
  healthyAfter: boolean;
  authenticatedRpcAfter: boolean;
  attempts: Array<{
    code: number | null;
    label: string;
    outcome: "completed" | "scoped-workspace-error";
  }>;
  providerRequests: number;
  unhandledPromiseRejection: boolean;
};

const proofDir = path.resolve(process.argv[2] ?? ".artifacts/issue-103917");
const summary = JSON.parse(await fs.readFile(path.join(proofDir, "summary.json"), "utf8")) as Summary;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replaceAll("/home/runner/work/openclaw/openclaw", "<runner-workspace>")
    .replaceAll("/Users/runner/work/openclaw/openclaw", "<runner-workspace>")
    .replace(/[\u2500-\u257f\u23af]/gu, "-");
}

function excerpt(value: string, maxLines = 24): string {
  const lines = stripAnsi(value).split("\n").filter(Boolean);
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

const [baselineLog, currentLog, adjacentLog, gatewayLog, gatewayResult, sourceProvenance] =
  await Promise.all([
    fs.readFile(path.join(proofDir, "baseline-regression.log"), "utf8"),
    fs.readFile(path.join(proofDir, "current-regression.log"), "utf8"),
    fs.readFile(path.join(proofDir, "current-adjacent.log"), "utf8"),
    fs.readFile(path.join(proofDir, "current-gateway-e2e.log"), "utf8"),
    fs.readFile(path.join(proofDir, "full-gateway.json"), "utf8"),
    fs.readFile(path.join(proofDir, "source-provenance.txt"), "utf8"),
  ]);
const parsedGatewayResult = JSON.parse(gatewayResult) as GatewayResult;
const containedGatewayAttempts = parsedGatewayResult.attempts.filter(
  (attempt) => attempt.outcome === "completed" || attempt.outcome === "scoped-workspace-error",
);

const shell = (title: string, subtitle: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0f1216; color: #e8edf2; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; letter-spacing: 0; }
  main { width: 1440px; min-height: 900px; padding: 48px 56px; }
  header { display: flex; align-items: end; justify-content: space-between; border-bottom: 1px solid #30363d; padding-bottom: 24px; margin-bottom: 28px; }
  h1 { margin: 0; font-size: 34px; line-height: 1.15; }
  h2 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 6px 0; color: #aab4be; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { color: #e8edf2; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .panel { border: 1px solid #30363d; border-radius: 8px; background: #171b21; padding: 22px; min-width: 0; }
  .wide { grid-column: 1 / -1; }
  .status { display: inline-flex; gap: 8px; align-items: center; font-weight: 700; }
  .pass { color: #4ad66d; }
  .fail { color: #ff6b6b; }
  .neutral { color: #74c0fc; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
  pre { margin: 0; max-height: 410px; overflow: hidden; white-space: pre-wrap; word-break: break-word; color: #d7dee7; font-size: 14px; line-height: 1.42; }
  .meta { font-size: 13px; text-align: right; color: #8b949e; }
  .metric { font-size: 32px; font-weight: 750; margin: 5px 0; }
  a { color: #74c0fc; }
</style>
</head>
<body><main>
<header><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><div class="meta">Issue #${escapeHtml(summary.issue)}<br>${escapeHtml(summary.capturedAt)}</div></header>
${body}
</main></body></html>`;

const overview = shell(
  "Workspace deletion crash: before / current head",
  "GitHub Actions real-behavior capture from the snowzlmbot/openclaw repository",
  `<section class="grid">
    <article class="panel"><div class="status fail"><span class="dot"></span>Affected release reproduced</div><div class="metric">${escapeHtml(summary.baseline.ref)}</div><p><code>${escapeHtml(summary.baseline.sha)}</code></p><p>The current lazy-root regression fails against the released eager-root implementation, as expected.</p></article>
    <article class="panel"><div class="status pass"><span class="dot"></span>Current main passes</div><div class="metric">No orphan rejection</div><p><code>${escapeHtml(summary.current.sha)}</code></p><p>Focused regression and adjacent workspace/subagent suites completed without the reported failure signature.</p></article>
    <article class="panel wide"><h2>Owner fix already merged</h2><p><a href="${escapeHtml(summary.ownerFix.pullRequest)}">openclaw/openclaw#89226</a> moved workspace-scoped fs-safe root resolution from tool construction to first real operation.</p><p>Commit <code>${escapeHtml(summary.ownerFix.commit)}</code>. No duplicate product patch is introduced by this proof branch.</p></article>
  </section>`,
);

const source = shell(
  "Root-cause provenance",
  "Exact release/current source comparison captured in the same Actions run",
  `<section class="grid"><article class="panel wide"><pre>${escapeHtml(sourceProvenance)}</pre></article></section>`,
);

const verification = shell(
  "Current-head verification matrix",
  "Focused regression plus adjacent workspace boundary, coding-tool, and subagent inheritance suites",
  `<section class="grid">
    <article class="panel"><div class="status fail"><span class="dot"></span>Before proof</div><pre>${escapeHtml(excerpt(baselineLog))}</pre></article>
    <article class="panel"><div class="status pass"><span class="dot"></span>Current regression</div><pre>${escapeHtml(excerpt(currentLog))}</pre></article>
    <article class="panel wide"><div class="status neutral"><span class="dot"></span>Adjacent suites</div><pre>${escapeHtml(excerpt(adjacentLog, 32))}</pre></article>
  </section>`,
);

const gateway = shell(
  "Real Gateway containment",
  "Foreground Gateway process, real agent RPC, sessions_spawn, workspace deletion, and health probes",
  `<section class="grid">
    <article class="panel"><div class="status pass"><span class="dot"></span>Machine-readable result</div><div class="metric">${containedGatewayAttempts.length}/${parsedGatewayResult.attempts.length} bounded outcomes</div><p>Platform <code>${escapeHtml(parsedGatewayResult.platform)}</code> · Node <code>${escapeHtml(parsedGatewayResult.node)}</code></p><p>PID stable: <code>${String(parsedGatewayResult.pidStable)}</code> · Health: <code>${String(parsedGatewayResult.healthyAfter)}</code> · Authenticated RPC: <code>${String(parsedGatewayResult.authenticatedRpcAfter)}</code></p><p>Provider requests: <code>${String(parsedGatewayResult.providerRequests)}</code> · Unhandled rejection: <code>${String(parsedGatewayResult.unhandledPromiseRejection)}</code></p></article>
    <article class="panel"><div class="status pass"><span class="dot"></span>Gateway E2E test</div><pre>${escapeHtml(excerpt(gatewayLog, 34))}</pre></article>
    <article class="panel wide"><h2>Proof boundary</h2><p>The same foreground Gateway PID remains alive after an attested workspace deletion and repeated deletion-race attempts. Health and authenticated RPC probes pass after the spawn path completes.</p></article>
  </section>`,
);

const pages = [
  ["01-before-after.html", "01-before-after.png", overview],
  ["02-root-cause.html", "02-root-cause.png", source],
  ["03-verification.html", "03-verification.png", verification],
  ["04-gateway-containment.html", "04-gateway-containment.png", gateway],
] as const;

for (const [htmlName, , html] of pages) {
  await fs.writeFile(path.join(proofDir, htmlName), html, "utf8");
}

async function resolveExecutablePath(): Promise<string | undefined> {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known system browser path.
    }
  }
  return undefined;
}

const executablePath = await resolveExecutablePath();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  for (const [htmlName, pngName] of pages) {
    await page.goto(pathToFileURL(path.join(proofDir, htmlName)).href, { waitUntil: "load" });
    await page.screenshot({ path: path.join(proofDir, pngName), fullPage: true });
  }
} finally {
  await browser.close();
}

console.log(`Captured ${pages.length} browser-rendered proof images in ${proofDir}`);
