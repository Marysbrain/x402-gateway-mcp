# x402-gateway-mcp

**The live x402 market feed for agents.** The `x402_market_pulse` tool is
FREE — no wallet, no payment, no signup: the x402 ecosystem in one snapshot,
refreshed ~3x/day — service listings by category with week-over-week deltas,
newly listed services, npm download trends for the core x402 packages,
protocol release tags, and per-source reliability grades. Every metric
carries a freshness stamp; a stale source says so instead of pretending.

Behind the feed, [Aye Scout](https://pulse.aye.today) exposes two paid
pre-payment diligence tools: x402 category coverage and a resource preflight
that checks reachability, terms, catalog presence, and observed age before an
agent spends. The tool list is fetched from the signed public manifest at
startup; compatibility-only routes are deliberately absent
([verify](https://pulse.aye.today/llms.txt)).

The manifest is verified over its exact response bytes before any paid tools
are registered. Both the treasury address and gateway signing-key ID are
pinned; an unsigned manifest or an unexpected key rotation stops startup.

> ⚠️ **Funded-wallet warning:** `WALLET_PRIVATE_KEY` signs real payments. Use a
> dedicated wallet holding only small balances (a few dollars of USDC). Never
> your main wallet. The key is read from env, never logged, and payment headers
> are never echoed into agent-visible output.

## 5-minute setup (Claude Desktop / Claude Code)

1. Create a fresh wallet and fund it with a small amount of USDC on Base
   (or Base Sepolia test USDC from <https://faucet.circle.com> while testing).
2. `npm install -g x402-gateway-mcp` (or use `npx`).
3. Add to your MCP config (Claude Desktop `claude_desktop_config.json`, or
   `claude mcp add` for Claude Code):

```json
{
  "mcpServers": {
    "x402-gateway": {
      "command": "npx",
      "args": ["-y", "x402-gateway-mcp"],
      "env": {
        "GATEWAY_URL": "https://<your-gateway-host>",
        "WALLET_PRIVATE_KEY": "0x<small-balance-wallet-key>",
        "MAX_PER_CALL_USD": "0.25",
        "MAX_SESSION_USD": "2.00"
      }
    }
  }
}
```

4. Restart the client. The free `x402_market_pulse` tool works immediately
   (no wallet needed); every paid tool description states its price, e.g.
   `[costs $0.01 USDC per call] Score an x402 resource before paying it…`

## Spend guardrails

- `MAX_PER_CALL_USD` (default **0.25**): tools priced above this are refused.
- `MAX_SESSION_USD` (default **2.00**): cumulative settled spend per server
  session; calls that would exceed it are refused with a clear message the
  agent can relay. Restart the server to reset.

Refusals happen **before** any payment is signed.

## Env reference

| Var | Default | Purpose |
|---|---|---|
| `GATEWAY_URL` | `https://pulse.aye.today` | Gateway base URL (override for local/testnet) |
| `WALLET_PRIVATE_KEY` | — | Buyer key (small balance!). Without it, tools list but calls fail with a clear error |
| `MAX_PER_CALL_USD` | `0.25` | Per-call cap |
| `MAX_SESSION_USD` | `2.00` | Per-session cap |
| `EXPECTED_PAY_TO` | Aye treasury address | Pinned payment destination; override only for a controlled test deployment |
| `EXPECTED_SIGNING_KID` | Aye production key ID | Pinned manifest signing key; rotate only with an audited gateway release |

If a transport or body-read error occurs after payment authorization, the MCP
reserves the full advertised amount as possibly spent. It will not silently
restore that session capacity; reconcile the wallet before retrying.
