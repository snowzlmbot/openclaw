import fs from "node:fs";
import path from "node:path";

const checkout = path.resolve(process.argv[2] ?? ".");
const output = path.resolve(process.argv[3] ?? "weixin-context.json");
const inboundPath = path.join(checkout, "src/messaging/inbound.ts");
const processPath = path.join(checkout, "src/messaging/process-message.ts");
const channelPath = path.join(checkout, "src/channel.ts");

const inbound = fs.readFileSync(inboundPath, "utf8");
const processMessage = fs.readFileSync(processPath, "utf8");
const channel = fs.readFileSync(channelPath, "utf8");

const checks = {
  contextTypeIsDirect: inbound.includes('ChatType: "direct";'),
  inboundValueIsDirect: inbound.includes('ChatType: "direct",'),
  routePeerIsDirect: processMessage.includes('peer: { kind: "direct", id: ctx.To }'),
  pluginCapabilityIsDirect: channel.includes('chatTypes: ["direct"]'),
};

if (Object.values(checks).some((value) => !value)) {
  throw new Error(`Weixin direct-context contract check failed: ${JSON.stringify(checks)}`);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ checks }, null, 2)}\n`);
console.log(JSON.stringify({ checks }));
