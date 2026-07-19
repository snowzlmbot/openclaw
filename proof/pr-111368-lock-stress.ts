import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadExecApprovals,
  normalizeExecApprovals,
  saveExecApprovals,
  updateExecApprovals,
} from "../../source/src/infra/exec-approvals.js";

const syncIterations = 500;
const asyncIterations = 500;
const readIterations = 500;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-111368-lock-proof-"));
const statePath = path.join(stateDir, "exec-approvals.json");
const lockPath = `${statePath}.lock`;

process.env.OPENCLAW_STATE_DIR = stateDir;
delete process.env.OPENCLAW_HOME;

function lockArtifacts(): string[] {
  return fs
    .readdirSync(stateDir)
    .filter((entry) => entry === path.basename(lockPath) || entry.startsWith(`${path.basename(lockPath)}.`));
}

function assertNoLockArtifacts(stage: string): void {
  const artifacts = lockArtifacts();
  if (artifacts.length > 0) {
    throw new Error(`${stage}: stranded lock artifacts: ${artifacts.join(", ")}`);
  }
}

try {
  for (let index = 0; index < syncIterations; index += 1) {
    saveExecApprovals(
      normalizeExecApprovals({
        version: 1,
        defaults: { security: index % 2 === 0 ? "allowlist" : "deny" },
      }),
    );
    assertNoLockArtifacts(`sync iteration ${index}`);
  }

  for (let index = 0; index < asyncIterations; index += 1) {
    await updateExecApprovals({
      update: (current) => ({
        ...current,
        defaults: { ...current.defaults, security: index % 2 === 0 ? "deny" : "allowlist" },
      }),
    });
    assertNoLockArtifacts(`async iteration ${index}`);
  }

  for (let index = 0; index < readIterations; index += 1) {
    const current = loadExecApprovals();
    if (current.version !== 1) {
      throw new Error(`read iteration ${index}: unexpected version ${String(current.version)}`);
    }
    assertNoLockArtifacts(`read iteration ${index}`);
  }

  const finalFile = loadExecApprovals();
  assertNoLockArtifacts("final read");
  console.log(
    JSON.stringify({
      result: "pass",
      syncIterations,
      asyncIterations,
      readIterations,
      finalSecurity: finalFile.defaults?.security,
      strandedLockArtifacts: lockArtifacts(),
    }),
  );
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}
