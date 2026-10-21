// Starts the server like an MCP client would and checks it without paying: the live tool
// list, and that a call is refused before any payment when no wallet is set or a tool
// costs more than the per-call cap.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function connect(env) {
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["index.js"], env: { ...process.env, ...env }, stderr: "ignore" }));
  return client;
}

const noWallet = await connect({ CHAINK9_PRIVATE_KEY: "" });
const { tools } = await noWallet.listTools();
const names = tools.map((t) => t.name);
for (const want of ["scan", "report", "feed", "simulate-trade", "liquidity-report"]) assert.ok(names.includes(want), `missing tool ${want}`);
assert.ok(tools.find((t) => t.name === "scan").inputSchema.properties.chain, "scan takes chain");
const refused = await noWallet.callTool({ name: "scan", arguments: { token: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" } });
assert.ok(refused.isError && refused.content[0].text.includes("No wallet configured"), refused.content[0].text);
await noWallet.close();

// A throwaway key: the cap stops the call before anything is signed.
const capped = await connect({ CHAINK9_PRIVATE_KEY: "0x" + "11".repeat(32), CHAINK9_MAX_USD_PER_CALL: "0.001" });
const overCap = await capped.callTool({ name: "scan", arguments: { token: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" } });
assert.ok(overCap.isError && overCap.content[0].text.includes("above CHAINK9_MAX_USD_PER_CALL"), overCap.content[0].text);
await capped.close();

console.log(`ok: ${tools.length} tools (${names.join(", ")}); no-wallet and per-call cap refuse before paying`);
