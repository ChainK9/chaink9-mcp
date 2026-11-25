// Checks examples/check-before-buy.mjs against a fake API: no network, no money. The x402 case
// signs a real payment with a throwaway key and checks it never pays above the $0.01 cap.
import assert from "node:assert/strict";
import { checkBeforeBuy, payer } from "../examples/check-before-buy.mjs";

const TOKEN = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const NOW = Date.parse("2026-11-25T12:00:00Z");
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const verdict = (v, age, extra = {}) => ({ token: TOKEN.toLowerCase(), chain: "bsc", verdict: v, scanned_at: minutesAgo(age), failed: [], warned: [], report_url: "https://chaink9.com/token/bsc/x", ...extra });
const lite = (v, results) => ({ token: TOKEN.toLowerCase(), chain: "bsc", verdict: v, tier: "lite", scanned_at: minutesAgo(0), results, report_url: "https://chaink9.com/token/bsc/x" });

/** A fake fetch: answers by path, records every call. */
function api(routes) {
  const calls = [];
  const f = async (input, init = {}) => {
    // The x402 wrapper hands fetch a Request; plain calls pass a URL and init.
    const req = new Request(input, init);
    const u = new URL(req.url);
    calls.push({ path: u.pathname, headers: req.headers });
    const r = routes[u.pathname];
    if (!r) return new Response("not found", { status: 404 });
    return typeof r === "function" ? r(req.headers) : Response.json(r);
  };
  f.calls = calls;
  return f;
}
const opts = (fetch, more = {}) => ({ fetch, pay: null, now: NOW, ...more });

// A fresh "ok" is free: no scan bought.
let f = api({ "/verdict": verdict("ok", 5) });
let d = await checkBeforeBuy(TOKEN, "bsc", opts(f));
assert.equal(d.buy, true);
assert.equal(d.paid, false);
assert.deepEqual(f.calls.map((c) => c.path), ["/verdict"]);

// "danger" is final at any age, and nothing is paid for.
f = api({ "/verdict": verdict("danger", 600, { failed: ["sellability"] }) });
d = await checkBeforeBuy(TOKEN, "bsc", opts(f, { pay: api({}) }));
assert.equal(d.buy, false);
assert.match(d.reason, /sellability/);
assert.equal(d.paid, false);

// "caution" is refused unless allowed.
f = api({ "/verdict": verdict("caution", 5, { warned: ["hidden_mint"] }) });
assert.equal((await checkBeforeBuy(TOKEN, "bsc", opts(f))).buy, false);
assert.equal((await checkBeforeBuy(TOKEN, "bsc", opts(f, { allowCaution: true }))).buy, true);

// A stale "ok" with nothing to pay with: don't buy, and say why.
f = api({ "/verdict": verdict("ok", 600) });
d = await checkBeforeBuy(TOKEN, "bsc", opts(f));
assert.equal(d.buy, false);
assert.match(d.reason, /CHAINK9_API_KEY/);

// A stale "ok" with an API key: a fresh scan-lite decides, and its results give the flagged checks.
const scanned = lite("danger", [
  { module: "sellability", severity: "critical", status: "fail" },
  { module: "buy_tax", severity: "high", status: "pass" },
]);
f = api({ "/verdict": verdict("ok", 600), "/scan-lite": scanned });
d = await checkBeforeBuy(TOKEN, "bsc", opts(f, { pay: payer({ apiKey: "ck9_live_test", fetch: f }) }));
assert.equal(d.buy, false);
assert.equal(d.paid, true);
assert.deepEqual(d.failed, ["sellability"]);
assert.equal(f.calls[1].path, "/scan-lite");
assert.equal(f.calls[1].headers.get("authorization"), "Bearer ck9_live_test");

// Not scanned yet, and the scan is refused (422: no liquidity yet): don't buy; ChainK9 doesn't charge for it.
f = api({ "/scan-lite": () => Response.json({ error: "no liquidity yet" }, { status: 422 }) });
d = await checkBeforeBuy(TOKEN, "bsc", opts(f, { pay: payer({ apiKey: "ck9_live_test", fetch: f }) }));
assert.equal(d.buy, false);
assert.match(d.reason, /422/);

// x402: the 402 is signed with the wallet and sent again; a price above the cap is never signed.
const challenge = (amount) => {
  const required = {
    x402Version: 2,
    resource: { url: "https://api.chaink9.com/scan-lite", description: "scan-lite", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x4724711c9d43084f9FBAe24d83a1bB4F21C5ec07", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
  };
  return (headers) =>
    headers.get("payment-signature")
      ? Response.json(lite("ok", []))
      : new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") } });
};
const KEY = "0x" + "11".repeat(32);
f = api({ "/scan-lite": challenge("5000") });
d = await checkBeforeBuy(TOKEN, "bsc", opts(f, { pay: payer({ privateKey: KEY, fetch: f }) }));
assert.equal(d.buy, true);
assert.equal(d.paid, true);
assert.ok(f.calls.at(-1).headers.get("payment-signature"), "the retry carries the signed payment");

f = api({ "/scan-lite": challenge("20000") });
await assert.rejects(checkBeforeBuy(TOKEN, "bsc", opts(f, { pay: payer({ privateKey: KEY, fetch: f }) })), /maxAmountPerPayment/);
assert.ok(!f.calls.some((c) => c.headers.get("payment-signature")), "$0.02 is above the cap and never signed");

await assert.rejects(checkBeforeBuy("0x123", "bsc", opts(api({}))), /0x address/);
console.log("ok: check-before-buy buys a fresh ok, refuses danger without paying, pays for a stale verdict by key or x402, and never signs above $0.01");
