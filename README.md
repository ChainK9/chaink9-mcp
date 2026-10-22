<p align="center"><img src="https://raw.githubusercontent.com/ChainK9/chaink9-mcp/main/icon.png" width="120" alt="ChainK9 logo"></p>

# ChainK9 MCP server

Token risk checks for AI agents on **BNB Smart Chain, Ethereum and Base**.

Most token scanners read flags from someone else's API. ChainK9 does what a buyer would: it
forks the chain and really buys and sells the token through its market (PancakeSwap or
Uniswap V2, V3 or V4, hooks included), then runs 60+ checks. A honeypot is caught by what it
does, not by what its code looks like.

Each successful call is paid automatically in **USDC on Base** with the
[x402](https://x402.org) protocol, from a wallet you choose. There is no account and no API
key, and failed calls (bad input, not a token, no liquidity, engine busy) are free.

## Tools

The tool list is read live from [api.chaink9.com](https://api.chaink9.com), so new products
appear without updating this package.

| Tool | Price | What it does |
|---|---|---|
| `scan` | $0.02 | Full check of a token: honeypot, buy/sell taxes and how they change, owner pause, blacklist, mint and confiscation powers, limits, liquidity, upgrade authority. Verdict: danger, caution or ok. |
| `scan-lite` | $0.005 | Faster check for bots (2–5 s): one real buy and sell plus the contract reads. Skips the extra trade and time-travel probes. |
| `report` | $0.002 | The latest stored scan of a token, without a new one. |
| `feed` | $0.002 | Tokens that just got a market, with a verdict where scanned. |
| `simulate-trade` | $0.02 | Buy or sell for a given wallet on a fork, with its real balances. |
| `exit-check` | $0.04 | Test up to four sell sizes from a wallet's real balance. |
| `transaction-preview` | $0.02 | Run any transaction on a fork and see balance changes. |
| `liquidity-report` | $0.003 | The token's pool: reserves and LP tokens (V2), or liquidity and price (V3/V4). |
| `launch-feed` | $0.003 | New markets that are actually funded, optionally by verdict. |
| `risk-changes` | $0.002 | What changed between a token's last two scans. |
| `deployer-report` | $0.005 | A token's verified creator and their other known tokens. |
| `portfolio-screen` | $0.005 | A wallet's balances of given tokens, riskiest first. |

Every tool takes `chain`: `bsc` (default), `eth` or `base`.

## Setup

1. Make a **new wallet just for this** and put a few dollars of **USDC on Base** in it. It
   needs no ETH: x402 payments are signatures, and the payment service pays the gas.
2. Add the server to your MCP client with that wallet's private key.

Claude Code:

```bash
claude mcp add chaink9 -e CHAINK9_PRIVATE_KEY=0x... -- npx -y chaink9-mcp
```

Cursor, Claude Desktop or any client with a JSON config:

```json
{
  "mcpServers": {
    "chaink9": {
      "command": "npx",
      "args": ["-y", "chaink9-mcp"],
      "env": { "CHAINK9_PRIVATE_KEY": "0x..." }
    }
  }
}
```

Claude Desktop can also install the `.mcpb` bundle from the
[releases](https://github.com/ChainK9/chaink9-mcp/releases) with a click.

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `CHAINK9_PRIVATE_KEY` | (required) | Private key of the dedicated Base wallet that pays. |
| `CHAINK9_MAX_USD_PER_CALL` | `0.05` | Any single payment above this is refused. |
| `CHAINK9_MAX_USD_PER_DAY` | `1` | Stops paying once this much was spent today (UTC). |

The daily total is kept in `~/.chaink9-mcp/spend.json`. The wallet only ever signs payments
on Base, and the key never leaves your machine.

## Disclaimer

ChainK9 reports what happened when it traded the token on a private copy of its blockchain at
the block shown. That is evidence, not a guarantee: a token's owner can change its rules after
the scan, and traps no check tests can be missed. Nothing here is financial advice; you trade
at your own risk.
