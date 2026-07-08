#!/usr/bin/env node
/**
 * x402-gateway-mcp: stdio MCP server that mirrors the gateway's endpoint
 * registry as tools and pays per call with a user-supplied wallet.
 *
 * On startup it fetches GATEWAY_URL/.well-known/x402.json and registers one
 * tool per endpoint — new gateway endpoints appear with zero code changes here.
 *
 * Env:
 *   GATEWAY_URL          gateway base URL (default http://localhost:8787)
 *   WALLET_PRIVATE_KEY   buyer key — SMALL BALANCES ONLY; signs real payments
 *   MAX_PER_CALL_USD     per-call spend cap (default 0.25)
 *   MAX_SESSION_USD      session spend cap (default 2.00)
 *
 * The private key is never logged; payment headers are never echoed.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { checkSpend, parsePriceUsd, type SpendConfig, type SpendState } from "./guards.js";

// Canonical production gateway; override with GATEWAY_URL for local/testnet.
const GATEWAY_URL = (process.env.GATEWAY_URL ?? "https://gateway.stride20k.com").replace(/\/$/, "");
const spendConfig: SpendConfig = {
  maxPerCallUsd: Number(process.env.MAX_PER_CALL_USD ?? "0.25"),
  maxSessionUsd: Number(process.env.MAX_SESSION_USD ?? "2.00"),
};
const spendState: SpendState = { sessionSpentUsd: 0 };

interface ManifestEndpoint {
  route: string;
  method: string;
  price: string;
  summary: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
  exampleInput: Record<string, string>;
}
interface Manifest {
  name: string;
  links?: Record<string, string>;
  endpoints: ManifestEndpoint[];
}

/** Track G3: the free market-pulse tool, registered when the gateway
 *  advertises it in manifest links. No wallet, no payment, no spend caps. */
const PULSE_TOOL = "x402_market_pulse";
const pulseToolDef = (path: string) => ({
  name: PULSE_TOOL,
  description:
    "[FREE — no payment, no wallet needed] The live x402 market feed for agents: " +
    "ecosystem snapshot with service listings by category, week-over-week deltas, " +
    "newly listed services, x402 npm download trends, and protocol releases. " +
    `Refreshed ~3x/day by the Stride20k collector. Served from ${path}.`,
  inputSchema: { type: "object" as const, properties: {} },
});

/** "/crypto/price/:coinId" -> "crypto_price" */
function toolName(route: string): string {
  return route
    .split("/")
    .filter((seg) => seg && !seg.startsWith(":"))
    .join("_")
    .replace(/[^a-zA-Z0-9_]/g, "_");
}

function buildUrl(endpoint: ManifestEndpoint, args: Record<string, unknown>): string {
  let path = endpoint.route;
  const used = new Set<string>();
  path = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    used.add(name);
    const v = args[name];
    if (v === undefined) throw new Error(`missing required parameter: ${name}`);
    return encodeURIComponent(String(v));
  });
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (!used.has(k) && v !== undefined && v !== null) query.set(k, String(v));
  }
  const qs = query.toString();
  return `${GATEWAY_URL}${path}${qs ? `?${qs}` : ""}`;
}

/** Belt-and-braces: strip anything key-shaped from text we return to agents. */
const redact = (s: string) => s.replace(/0x[a-fA-F0-9]{64}/g, "0x[REDACTED]");

async function main() {
  // Manifest fetch (free route) — tool list derives entirely from it.
  const manifestRes = await fetch(`${GATEWAY_URL}/.well-known/x402.json`);
  if (!manifestRes.ok) {
    console.error(`Failed to fetch gateway manifest from ${GATEWAY_URL}: HTTP ${manifestRes.status}`);
    process.exit(1);
  }
  const manifest = (await manifestRes.json()) as Manifest;
  const byTool = new Map(manifest.endpoints.map((e) => [toolName(e.route), e]));

  // Paying fetch is built lazily so listing tools works without a wallet.
  let payingFetch: typeof fetch | null = null;
  const getPayingFetch = (): typeof fetch => {
    const key = process.env.WALLET_PRIVATE_KEY;
    if (!key) {
      throw new Error(
        "WALLET_PRIVATE_KEY is not configured — cannot pay for calls. Set it in the MCP server env (testnet/small balance only).",
      );
    }
    if (!payingFetch) {
      const account = privateKeyToAccount(key as `0x${string}`);
      payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
        schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
      }) as typeof fetch;
    }
    return payingFetch;
  };

  const server = new Server(
    { name: "x402-gateway-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  const pulsePath = manifest.links?.market_pulse;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // The free feed leads (Track G3/G5): it is the reason to install.
      ...(pulsePath ? [pulseToolDef(pulsePath)] : []),
      ...manifest.endpoints.map((e) => ({
        name: toolName(e.route),
        description: `[costs ${e.price} USDC per call] ${e.summary} ${e.description}`,
        inputSchema: e.inputSchema as { type: "object"; properties: Record<string, unknown> },
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const fail = (text: string) => ({ content: [{ type: "text" as const, text: redact(text) }], isError: true });

    if (pulsePath && req.params.name === PULSE_TOOL) {
      // Free route: plain fetch, no payment wrapper, no spend accounting.
      try {
        const res = await fetch(`${GATEWAY_URL}${pulsePath}`);
        const body = await res.text();
        return { content: [{ type: "text" as const, text: redact(body) }], isError: res.status !== 200 };
      } catch (err) {
        return fail(`market-pulse fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const endpoint = byTool.get(req.params.name);
    if (!endpoint) return fail(`Unknown tool: ${req.params.name}`);

    const priceUsd = parsePriceUsd(endpoint.price);
    if (priceUsd === null) return fail(`Gateway advertised an unparseable price: ${endpoint.price}`);
    const refusal = checkSpend(priceUsd, spendState, spendConfig);
    if (refusal) return fail(refusal);

    let url: string;
    try {
      url = buildUrl(endpoint, (req.params.arguments ?? {}) as Record<string, unknown>);
    } catch (err) {
      return fail(String(err instanceof Error ? err.message : err));
    }

    try {
      // POST routes (ADR-005) take the tool arguments as a JSON body.
      const res =
        endpoint.method === "POST"
          ? await getPayingFetch()(`${GATEWAY_URL}${endpoint.route}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(req.params.arguments ?? {}),
            })
          : await getPayingFetch()(url, { method: "GET" });
      const body = await res.text();

      let paid = false;
      const settleHeader = res.headers.get("PAYMENT-RESPONSE");
      if (settleHeader) {
        try {
          const settle = decodePaymentResponseHeader(settleHeader) as { success?: boolean };
          paid = settle.success !== false;
        } catch {
          paid = res.status === 200; // settled header unparseable; count conservatively
        }
      }
      if (paid) spendState.sessionSpentUsd += priceUsd;

      const note = paid
        ? `\n\n[paid ${endpoint.price}; session spend $${spendState.sessionSpentUsd.toFixed(3)} of $${spendConfig.maxSessionUsd}]`
        : "";
      return {
        content: [{ type: "text" as const, text: redact(body) + note }],
        isError: res.status !== 200,
      };
    } catch (err) {
      return fail(`Call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await server.connect(new StdioServerTransport());
  console.error(
    `x402-gateway-mcp ready: ${byTool.size} tools from ${GATEWAY_URL} (caps: $${spendConfig.maxPerCallUsd}/call, $${spendConfig.maxSessionUsd}/session)`,
  );
}

main().catch((err) => {
  console.error("x402-gateway-mcp failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
