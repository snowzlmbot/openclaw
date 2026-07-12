import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cleanupOpenClawOwnedAcpxProcessTree } from "../../extensions/acpx/src/process-reaper.ts";

const controlDir = process.argv[2];
if (!controlDir) {
  throw new Error("control directory is required");
}

const leaseId = `proof-lease-${process.pid}`;
const gatewayInstanceId = `proof-gateway-${process.pid}`;
const leaseEnv = {
  ...process.env,
  OPENCLAW_ACPX_LEASE_ID: leaseId,
  OPENCLAW_GATEWAY_INSTANCE_ID: gatewayInstanceId,
};
const launcherPidFile = path.join(controlDir, "leased.pid");
const launcher = spawn(
  process.execPath,
  [
    "-e",
    [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
      "  detached: true,",
      '  stdio: "ignore",',
      "  env: process.env,",
      "});",
      "child.unref();",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
    ].join(" "),
    launcherPidFile,
  ],
  { env: leaseEnv, stdio: "ignore" },
);
if (!launcher.pid) {
  throw new Error("leased launcher pid unavailable");
}
await new Promise<void>((resolve, reject) => {
  launcher.once("error", reject);
  launcher.once("exit", () => resolve());
});

const persistent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
if (!persistent.pid) {
  throw new Error("persistent background pid unavailable");
}
persistent.unref();

const leasedPid = Number.parseInt(fs.readFileSync(launcherPidFile, "utf8").trim(), 10);
fs.writeFileSync(
  path.join(controlDir, "ready.json"),
  JSON.stringify({
    servicePid: process.pid,
    launcherPid: launcher.pid,
    leasedPid,
    persistentPid: persistent.pid,
    leaseId,
    gatewayInstanceId,
  }),
);

const trigger = path.join(controlDir, "abort");
while (!fs.existsSync(trigger)) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
}

const cleanup = await cleanupOpenClawOwnedAcpxProcessTree({
  rootPid: launcher.pid,
  rootCommand: "node /tmp/openclaw/acpx/proof-wrapper.mjs",
  expectedLeaseId: leaseId,
  expectedGatewayInstanceId: gatewayInstanceId,
  wrapperRoot: "/tmp/openclaw/acpx",
});
fs.writeFileSync(path.join(controlDir, "result.json"), JSON.stringify(cleanup));

setInterval(() => {}, 1000);
