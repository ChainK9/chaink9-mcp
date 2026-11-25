#!/usr/bin/env node
// Check a token with ChainK9 before a bot buys it.
//
//   node examples/check-before-buy.mjs 0xTOKEN [bsc|eth|base|arc]
//
// 1. Ask for the stored verdict. It is free (30 calls a minute per IP).
// 2. A stored "danger" is final: don't buy, don't pay. If there is no verdict, it is older than
//    MAX_AGE_MINUTES, or it could not decide, pay for a fresh
//    scan-lite ($0.005): one real buy and sell on a fork of the chain plus the contract checks.
//    It pays with CHAINK9_API_KEY (credits from your chaink9.com account) if set, else with x402
//    from the wallet in CHAINK9_PRIVATE_KEY (a few dollars of USDC on Base, no ETH needed).
// 3. Buy only on "ok". "danger" means a check failed, for example the sell reverted on the fork.
//    "caution" means a high or critical check warned; ALLOW_CAUTION=1 lets those through.
//
// Exit code: 0 buy, 1 don't buy, 2 could not check (treat as don't buy). Put your own buy after it.
import { pathToFileURL } from "node:url";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const API = "https://api.chaink9.com";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CHAINS = ["bsc", "eth", "base", "arc"];

/** How to pay for a fresh scan: an API key, an x402 wallet, or nothing (stored verdicts only). */
export function payer({ apiKey = process.env.CHAINK9_API_KEY, privateKey = process.env.CHAINK9_PRIVATE_KEY, fetch = globalThis.fetch } = {}) {
  if (apiKey) return (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${apiKey}` } });
  if (privateKey) {
    const account = privateKeyToAccount(privateKey);
    // Signs USDC payments on Base only, and none above $0.01: scan-lite costs $0.005.
    return wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
      spendControls: { maxAmountPerPayment: "$0.01" },
    });
  }
  return null;
}

/**
 * Decides whether to buy. Returns { buy, reason, verdict, paid, failed, warned, report_url }.
 * buy is true only for a fresh "ok" (or "caution" when allowCaution is set).
 */
export async function checkBeforeBuy(token, chain = "bsc", { maxAgeMinutes = 60, allowCaution = false, fetch = globalThis.fetch, pay = payer({ fetch }), now = Date.now() } = {}) {
  if (!ADDRESS.test(token)) throw new Error("token must be a 0x address");
  if (!CHAINS.includes(chain)) throw new Error(`chain must be one of ${CHAINS.join(", ")}`);
  const query = new URLSearchParams({ token, chain });

  let report = null;
  let paid = false;
  const res = await fetch(`${API}/verdict?${query}`, { signal: AbortSignal.timeout(30_000) });
  if (res.ok) report = await res.json();
  else if (res.status !== 404) return decide(null, false, `free verdict answered ${res.status}`);

  const age = report?.scanned_at ? (now - Date.parse(report.scanned_at)) / 60_000 : Infinity;
  // A trap seen once is reason enough to stay out; only a verdict that might let the buy through needs to be fresh.
  if (report?.verdict !== "danger" && (!report || report.verdict === "unknown" || !(age <= maxAgeMinutes))) {
    if (!pay) return decide(report, false, report ? `stored verdict is ${Math.round(age)} min old and no CHAINK9_API_KEY or CHAINK9_PRIVATE_KEY is set to pay for a fresh scan` : "not scanned yet and nothing set to pay for a scan");
    const scan = await pay(`${API}/scan-lite?${query}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(120_000) });
    // ChainK9 charges only for 2xx answers: 422 (not a token, no liquidity yet) and 5xx are free.
    if (!scan.ok) return decide(report, false, `scan-lite answered ${scan.status}: ${(await scan.text()).slice(0, 200)}`);
    report = await scan.json();
    paid = true;
  }
  return decide(report, paid, null, allowCaution);
}

function decide(report, paid, problem, allowCaution = false) {
  // The free verdict lists the flagged checks; a scan report has every check's result instead.
  const flagged = (status) =>
    (report?.results ?? []).filter((r) => r.status === status && (status === "fail" || ["high", "critical"].includes(r.severity))).map((r) => r.module);
  const verdict = report?.verdict ?? "unknown";
  const out = { verdict, paid, failed: report?.failed ?? flagged("fail"), warned: report?.warned ?? flagged("warn"), report_url: report?.report_url ?? null };
  if (problem) return { buy: false, reason: problem, ...out };
  if (verdict === "ok") return { buy: true, reason: "no trap found", ...out };
  if (verdict === "caution" && allowCaution) return { buy: true, reason: `caution allowed: ${out.warned.join(", ")}`, ...out };
  if (verdict === "danger") return { buy: false, reason: `failed: ${out.failed.join(", ")}`, ...out };
  if (verdict === "caution") return { buy: false, reason: `warned: ${out.warned.join(", ")}`, ...out };
  return { buy: false, reason: "ChainK9 could not decide", ...out };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [token, chain = "bsc"] = process.argv.slice(2);
  if (!token) {
    console.error("usage: node examples/check-before-buy.mjs 0xTOKEN [bsc|eth|base|arc]");
    process.exit(2);
  }
  try {
    const d = await checkBeforeBuy(token, chain, { maxAgeMinutes: Number(process.env.MAX_AGE_MINUTES || 60), allowCaution: process.env.ALLOW_CAUTION === "1" });
    console.log(JSON.stringify(d, null, 2));
    process.exit(d.buy ? 0 : d.verdict === "unknown" ? 2 : 1);
  } catch (e) {
    console.error(`could not check: ${e?.message ?? e}`);
    process.exit(2);
  }
}
