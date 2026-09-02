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
 *   EXPECTED_PAY_TO      pinned treasury address (production default built in)
 *   EXPECTED_SIGNING_KID pinned gateway signing-key id (production default)
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
import {
  checkSpend,
  bookAuthorizedSpend,
  paymentAccountingState,
  parsePriceAtomic,
  parsePriceUsd,
  selectBoundPaymentRequirement,
  type SpendConfig,
  type SpendState,
} from "./guards.js";
import {
  DEFAULT_EXPECTED_SIGNING_KID,
  MANIFEST_SIGNATURE_HEADER,
  SIGNING_KEY_PATH,
  verifyManifestSignature,
  type SigningKeyDocument,
} from "./manifest-trust.js";
import { buildTargetUrl } from "./url.js";

// Canonical production gateway; override with GATEWAY_URL for local/testnet.
const GATEWAY_URL = (process.env.GATEWAY_URL ?? "https://pulse.aye.today").replace(/\/$/, "");
/** Caps must be plain numbers. Number("$0.25") is NaN, and NaN loses every
 *  comparison, so an unvalidated cap of "$0.25" silently authorized unlimited
 *  spending. Refuse to start rather than run with a guard that isn't guarding —
 *  this process holds a key that moves the user's money. */
function requireCapUsd(name: string, raw: string | undefined, fallback: string): number {
  const value = Number((raw ?? fallback).trim());
  if (!Number.isFinite(value) || value < 0) {
    console.error(
      `[x402-mcp] ${name}="${raw}" is not a valid amount. Use a plain number ` +
        `like ${fallback} — not "$${fallback}". Refusing to start.`,
    );
    process.exit(1);
  }
  return value;
}
const spendConfig: SpendConfig = {
  maxPerCallUsd: requireCapUsd("MAX_PER_CALL_USD", process.env.MAX_PER_CALL_USD, "0.25"),
  maxSessionUsd: requireCapUsd("MAX_SESSION_USD", process.env.MAX_SESSION_USD, "2.00"),
};
const spendState: SpendState = { sessionSpentUsd: 0, pendingUsd: 0 };

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
  payment: {
    x402Version: number;
    scheme: string;
    network: string;
    asset: string;
    payTo: string;
  };
  links?: Record<string, string>;
  endpoints: ManifestEndpoint[];
}

const BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const DEFAULT_EXPECTED_PAY_TO = "0x552Cc4A10878C7F20574489D47184249657Ca3f6";
const EXPECTED_PAY_TO = (process.env.EXPECTED_PAY_TO ?? DEFAULT_EXPECTED_PAY_TO).toLowerCase();
const EXPECTED_SIGNING_KID = process.env.EXPECTED_SIGNING_KID ?? DEFAULT_EXPECTED_SIGNING_KID;

/** Track G3: the free market-pulse tool, registered when the gateway
 *  advertises it in manifest links. No wallet, no payment, no spend caps. */
const PULSE_TOOL = "x402_market_pulse";
const pulseToolDef = (path: string) => ({
  name: PULSE_TOOL,
  description:
    "[FREE — no payment, no wallet needed] The live x402 market feed for agents: " +
    "ecosystem snapshot with service listings by category, week-over-week deltas, " +
    "newly listed services, x402 npm download trends, and protocol releases. " +
    `Refreshed ~3x/day by Aye Pulse. Served from ${path}.`,
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

/** Belt-and-braces: strip anything key-shaped from text we return to agents. */
const redact = (s: string) => s.replace(/0x[a-fA-F0-9]{64}/g, "0x[REDACTED]");

async function main() {
  const gatewayOrigin = new URL(GATEWAY_URL);
  if (gatewayOrigin.protocol !== "https:" && gatewayOrigin.hostname !== "localhost" && gatewayOrigin.hostname !== "127.0.0.1") {
    console.error("GATEWAY_URL must use HTTPS outside local development; refusing to load paid tools");
    process.exit(1);
  }
  // Manifest fetch (free route) — tool list derives entirely from it.
  const manifestRes = await fetch(`${GATEWAY_URL}/.well-known/x402.json`);
  if (!manifestRes.ok) {
    console.error(`Failed to fetch gateway manifest from ${GATEWAY_URL}: HTTP ${manifestRes.status}`);
    process.exit(1);
  }
  if (new URL(manifestRes.url).origin !== gatewayOrigin.origin) {
    throw new Error("Gateway manifest redirected to a different origin");
  }
  const manifestBody = await manifestRes.text();
  const keyRes = await fetch(`${GATEWAY_URL}${SIGNING_KEY_PATH}`);
  if (!keyRes.ok || new URL(keyRes.url).origin !== gatewayOrigin.origin) {
    throw new Error("Gateway signing key is unavailable or redirected");
  }
  const keyDocument = (await keyRes.json()) as SigningKeyDocument;
  await verifyManifestSignature(
    manifestBody,
    manifestRes.headers.get(MANIFEST_SIGNATURE_HEADER),
    keyDocument,
    EXPECTED_SIGNING_KID,
  );
  const manifest = JSON.parse(manifestBody) as Manifest;
  if (
    manifest.payment?.x402Version !== 2 ||
    manifest.payment?.scheme !== "exact" ||
    manifest.payment?.network !== "eip155:8453" ||
    manifest.payment?.asset !== "USDC" ||
    !/^0x[0-9a-fA-F]{40}$/.test(manifest.payment?.payTo ?? "") ||
    manifest.payment.payTo.toLowerCase() !== EXPECTED_PAY_TO
  ) {
    console.error("Gateway manifest payment identity is missing or unsupported; refusing to load paid tools");
    process.exit(1);
  }
  const byTool = new Map(manifest.endpoints.map((e) => [toolName(e.route), e]));

  // Paying fetch is built lazily so listing tools works without a wallet.
  let payingAccount: ReturnType<typeof privateKeyToAccount> | null = null;
  const getPayingFetch = (endpoint: ManifestEndpoint): typeof fetch => {
    const key = process.env.WALLET_PRIVATE_KEY;
    if (!key) {
      throw new Error(
        "WALLET_PRIVATE_KEY is not configured — cannot pay for calls. Set it in the MCP server env (testnet/small balance only).",
      );
    }
    if (!payingAccount) payingAccount = privateKeyToAccount(key as `0x${string}`);
    const amountAtomic = parsePriceAtomic(endpoint.price);
    if (amountAtomic === null) throw new Error(`Gateway advertised an unsafe price: ${endpoint.price}`);
    return wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(payingAccount) }],
      paymentRequirementsSelector: (version, requirements) =>
        selectBoundPaymentRequirement(version, requirements, {
          amountAtomic,
          network: manifest.payment.network,
          asset: BASE_MAINNET_USDC,
          payTo: manifest.payment.payTo,
        }),
    }) as typeof fetch;
  };

  const server = new Server(
    { name: "x402-gateway-mcp", version: "0.3.0" },
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
      url = buildTargetUrl(GATEWAY_URL, endpoint, (req.params.arguments ?? {}) as Record<string, unknown>);
    } catch (err) {
      return fail(String(err instanceof Error ? err.message : err));
    }

    // RESERVE before the round trip. The cap check above and the increment
    // below straddle an await, so without this two concurrent tool calls both
    // read the same total and both proceed. MCP clients batch calls as a matter
    // of course, so this needed no hostile input: six parallel $1.00 calls
    // cleared a $2.00 cap and spent $6.00. Released in the finally.
    spendState.pendingUsd += priceUsd;
    let booked = false;
    try {
      // POST routes (ADR-005) take the tool arguments as a JSON body.
      const res =
        endpoint.method === "POST"
          ? await getPayingFetch(endpoint)(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(req.params.arguments ?? {}),
            })
          : await getPayingFetch(endpoint)(url, { method: "GET" });
      let paid = false;
      const settleHeader = res.headers.get("PAYMENT-RESPONSE");
      if (settleHeader) {
        try {
          const settle = decodePaymentResponseHeader(settleHeader) as { success?: boolean };
          paid = settle.success !== false;
        } catch {
          paid = res.status === 200; // settled header unparseable; count conservatively
        }
      } else {
        // No settle header, but a 200 from a PAID route still means money moved.
        // The header is non-standard and a proxy or CDN can strip it; treating
        // that as "free" left the session cap permanently unreachable while
        // every call kept settling on-chain. Count it against the user's cap.
        paid = res.status === 200;
      }
      const accounting = paymentAccountingState(
        res.status, paid, res.headers.get("x-payment-state"));
      const ambiguous = accounting === "ambiguous";
      paid = accounting === "paid";
      if (paid || ambiguous) {
        bookAuthorizedSpend(spendState, priceUsd);
        booked = true;
      }
      // Book the receipt (or explicit ambiguity) BEFORE consuming the body. A
      // body-stream failure after settlement must not restore session capacity.
      const body = await res.text();

      const note = paid || ambiguous
        ? `\n\n[${ambiguous ? "possibly paid — reconcile; do not repay" : `paid ${endpoint.price}`}; session reserved/spent $${spendState.sessionSpentUsd.toFixed(3)} of $${spendConfig.maxSessionUsd}]`
        : "";
      return {
        content: [{ type: "text" as const, text: redact(body) + note }],
        isError: res.status !== 200,
      };
    } catch (err) {
      if (!booked) {
        // The paying wrapper may have dispatched settlement before the transport
        // error surfaced. Reserve the full authorization and stop optimistic reuse.
        bookAuthorizedSpend(spendState, priceUsd);
        booked = true;
      }
      return fail(`Call failed after payment authorization; $${priceUsd.toFixed(6)} is reserved as possibly spent. Do not retry until reconciled: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Always release the reservation — the spend, if it happened, has moved
      // into sessionSpentUsd above. A throw between settlement and here would
      // otherwise leak the reservation and shrink the cap for the whole session.
      spendState.pendingUsd -= priceUsd;
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
