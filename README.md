# x402-gateway-mcp

A provider-neutral stdio [Model Context Protocol](https://modelcontextprotocol.io/)
server for [Aye Pulse and Scout](https://pulse.aye.today).

The free `x402_market_pulse` tool returns a freshness-stamped x402 ecosystem
snapshot. The signed public gateway manifest currently adds two paid diligence
tools: category coverage and a resource preflight. Compatibility-only gateway
routes are intentionally not exposed by this package.

Before registering paid tools, the server verifies the manifest over its exact
response bytes and checks its pinned signing-key ID and treasury address. An
unsigned manifest, unexpected key rotation, or mismatched payment requirement
fails closed.

> **Funded-wallet warning:** `WALLET_PRIVATE_KEY` signs real payments. Use a
> dedicated wallet with only a small USDC balance, never a primary wallet. The
> key is read from the environment and is not logged. Payment authorization
> headers are not returned in tool output.

## Client and model compatibility

The server does not hardcode or call a model. It works with MCP hosts that can
launch a local stdio server. That can include Codex sessions using GPT-6 Astra,
Claude Desktop, Claude Code, and other compatible clients; availability and
configuration depend on the selected client and account.

This package does not call the OpenAI API or require an OpenAI API key. ChatGPT
and Codex plan access is separate from API usage and billing; do not assume a
ChatGPT Business, Pro, or other subscription includes API credits.

## Setup

1. Install with `npm install -g x402-gateway-mcp`, or let the client invoke it
   with `npx`.
2. Add a local stdio MCP server to the client. Configuration shapes differ, but
   the process definition is equivalent to:

```json
{
  "mcpServers": {
    "x402-gateway": {
      "command": "npx",
      "args": ["-y", "x402-gateway-mcp"],
      "env": {
        "MAX_PER_CALL_USD": "0.25",
        "MAX_SESSION_USD": "2.00"
      }
    }
  }
}
```

3. Restart or reconnect the client. The free `x402_market_pulse` tool needs no
   wallet. To use a paid tool, create a dedicated small-balance wallet and add
   `WALLET_PRIVATE_KEY` to the server environment.

Every paid tool description states its price. Calls above either configured cap
are refused before a payment is signed.

## Spend guardrails

- `MAX_PER_CALL_USD` defaults to `0.25` and limits one call.
- `MAX_SESSION_USD` defaults to `2.00` and limits settled or possibly settled
  spend for one server process. Restarting the process resets this local total.

If a transport or body-read error occurs after payment authorization, the
server conservatively reserves the advertised amount as possibly spent. Check
the wallet before retrying.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_URL` | `https://pulse.aye.today` | Gateway base URL; override only for a controlled local or test deployment |
| `WALLET_PRIVATE_KEY` | — | Optional buyer key for paid tools; use a dedicated small-balance wallet |
| `MAX_PER_CALL_USD` | `0.25` | Per-call spend cap |
| `MAX_SESSION_USD` | `2.00` | Per-process spend cap |
| `EXPECTED_PAY_TO` | Aye treasury address | Pinned payment destination; override only for a controlled test deployment |
| `EXPECTED_SIGNING_KID` | Aye production key ID | Pinned manifest signing key; change only with an audited gateway release |

## Development

```sh
npm ci
npm test
npm run typecheck
npm run verify:dist
npm run pack:check
```

`src/` is canonical. `dist/` remains committed because the npm executable points
to `dist/index.js`; `verify:dist` rebuilds it and fails if generated output is
not committed.

This repository owns the published `x402-gateway-mcp` package. The gateway
repository owns the HTTP service and signed manifest; changes to that service
do not automatically update the installed stdio package. Package publication
is a separate release step and is not performed by these local checks.
