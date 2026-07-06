# x402-gateway-mcp

Stdio MCP server that exposes every [x402-gateway](../README.md) data endpoint as an
MCP tool and **pays for calls with your wallet** (USDC on Base, x402 protocol).
Tool list is fetched from the gateway's `/.well-known/x402.json` at startup —
new gateway endpoints appear automatically.

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

4. Restart the client. Every tool description states its price, e.g.
   `[costs $0.005 USDC per call] Get the current USD price of a cryptocurrency…`

## Spend guardrails

- `MAX_PER_CALL_USD` (default **0.25**): tools priced above this are refused.
  Note: the gateway's premium `/report/domain` dossier costs **$1.00** — set
  `MAX_PER_CALL_USD=1.25` to enable it; the default deliberately keeps
  premium tools opt-in.
- `MAX_SESSION_USD` (default **2.00**): cumulative settled spend per server
  session; calls that would exceed it are refused with a clear message the
  agent can relay. Restart the server to reset.

Refusals happen **before** any payment is signed.

## Env reference

| Var | Default | Purpose |
|---|---|---|
| `GATEWAY_URL` | `https://gateway.stride20k.com` | Gateway base URL (override for local/testnet) |
| `WALLET_PRIVATE_KEY` | — | Buyer key (small balance!). Without it, tools list but calls fail with a clear error |
| `MAX_PER_CALL_USD` | `0.25` | Per-call cap |
| `MAX_SESSION_USD` | `2.00` | Per-session cap |
