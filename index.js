#!/usr/bin/env node
// chaink9-mcp: ChainK9's token risk checks as MCP tools, paid per call with x402 (USDC on Base,
// or USDT on BNB Smart Chain).
// Tools come from the live catalog (https://api.chaink9.com/openapi.json), so new products
// appear without updating this package.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { parseUnits } from "viem";

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const API = "https://api.chaink9.com";
// Where the wallet pays. BSC's USDT has no EIP-3009, so it goes through Permit2: the first payment
// also signs a one-time approval, which needs a little BNB for gas.
const NETWORKS = {
  base: { id: "eip155:8453", label: "USDC on Base", wallet: "a little USDC on Base (no ETH needed)" },
  bsc: {
    id: "eip155:56",
    label: "USDT on BNB Smart Chain",
    wallet: "a little USDT on BNB Smart Chain, plus about $0.01 of BNB for the one-time Permit2 approval",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    rpcUrl: "https://bsc-dataseed.bnbchain.org", // reads the Permit2 allowance, prices the approval
  },
};
const PAY = NETWORKS[(process.env.CHAINK9_PAY_NETWORK || "base").trim().toLowerCase()];
if (!PAY) {
  console.error(`[chaink9] CHAINK9_PAY_NETWORK must be one of: ${Object.keys(NETWORKS).join(", ")}`);
  process.exit(1);
}
const MAX_PER_CALL = Number(process.env.CHAINK9_MAX_USD_PER_CALL || 0.05);
const MAX_PER_DAY = Number(process.env.CHAINK9_MAX_USD_PER_DAY || 1);
const DIR = join(homedir(), ".chaink9-mcp");
const LEDGER = join(DIR, "spend.json");
const log = (...a) => console.error("[chaink9]", ...a); // stdout carries the MCP protocol

// ---------------------------------------------------------------- catalog
let catalog; // name -> { path, price, tool }
async function loadCatalog() {
  if (catalog) return catalog;
  const res = await fetch(`${API}/openapi.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`could not load the ChainK9 catalog (HTTP ${res.status})`);
  const spec = await res.json();
  catalog = new Map();
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    const op = ops.post;
    if (!op) continue;
    const price = Number(op["x-payment-info"]?.price?.amount ?? NaN);
    const name = path.slice(1).replace(/[^a-zA-Z0-9_-]/g, "_");
    catalog.set(name, {
      path,
      price,
      tool: {
        name,
        description: `${op.description || op.summary || name} Costs $${price} per successful call, paid automatically in ${PAY.label}; failed calls are free.`,
        inputSchema: op.requestBody?.content?.["application/json"]?.schema ?? { type: "object", properties: {} },
      },
    });
  }
  log(`${catalog.size} tools from ${API}`);
  return catalog;
}

// ---------------------------------------------------------------- wallet and limits
let payFetch;
function payer() {
  if (payFetch) return payFetch;
  const key = process.env.CHAINK9_PRIVATE_KEY;
  if (!key) return null;
  // The x402 client signs payments on PAY's network only and refuses any single one above the cap,
  // whatever a server asks for. x402 clients pay only in tokens they know by default; BSC's USDT
  // isn't one, so it's opted in with the same cap in its 18 decimals.
  const account = privateKeyToAccount(key);
  payFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: PAY.id, client: PAY.rpcUrl ? new ExactEvmScheme(account, { 56: { rpcUrl: PAY.rpcUrl } }) : new ExactEvmScheme(account) }],
    spendControls: {
      maxAmountPerPayment: `$${MAX_PER_CALL}`,
      ...(PAY.usdt && { allowedAssets: [{ network: PAY.id, asset: PAY.usdt, maxAmountPerPayment: parseUnits(String(MAX_PER_CALL), 18).toString() }] }),
    },
  });
  return payFetch;
}

const today = () => new Date().toISOString().slice(0, 10);
function spentToday() {
  try {
    const l = JSON.parse(readFileSync(LEDGER, "utf8"));
    return l.day === today() ? l.usd : 0;
  } catch {
    return 0;
  }
}
function addSpend(usd) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(LEDGER, JSON.stringify({ day: today(), usd: Math.round((spentToday() + usd) * 1e6) / 1e6 }));
}

// ---------------------------------------------------------------- MCP
const fail = (text) => ({ isError: true, content: [{ type: "text", text }] });
const server = new Server({ name: "chaink9", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...(await loadCatalog()).values()].map((t) => t.tool) }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const entry = (await loadCatalog()).get(req.params.name);
  if (!entry) return fail(`Unknown tool ${req.params.name}.`);
  const pay = payer();
  if (!pay) return fail(`No wallet configured. Set CHAINK9_PRIVATE_KEY to the private key of a dedicated wallet holding ${PAY.wallet}; see https://api.chaink9.com.`);
  if (!(entry.price <= MAX_PER_CALL)) return fail(`${req.params.name} costs $${entry.price}, above CHAINK9_MAX_USD_PER_CALL ($${MAX_PER_CALL}).`);
  if (spentToday() + entry.price > MAX_PER_DAY) return fail(`Daily limit reached: $${spentToday()} of CHAINK9_MAX_USD_PER_DAY ($${MAX_PER_DAY}) spent today.`);

  let res;
  try {
    res = await pay(`${API}${entry.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `chaink9-mcp/${VERSION}` },
      body: JSON.stringify(req.params.arguments ?? {}),
      signal: AbortSignal.timeout(120_000), // a full scan takes 10-40 s
    });
  } catch (e) {
    return fail(`Payment or request failed: ${e?.message ?? e}`);
  }
  const receipt = res.headers.get("payment-response");
  if (receipt) {
    try {
      if (decodePaymentResponseHeader(receipt).success) addSpend(entry.price);
    } catch {}
  }
  const text = await res.text();
  // ChainK9 charges only for 2xx answers; say so, so the agent can fix its input or retry.
  if (!res.ok) return fail(`${req.params.name} answered ${res.status} (not charged): ${text.slice(0, 2000)}`);
  return { content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());
log(`chaink9-mcp ${VERSION} ready (pays in ${PAY.label}; limits: $${MAX_PER_CALL}/call, $${MAX_PER_DAY}/day)`);
