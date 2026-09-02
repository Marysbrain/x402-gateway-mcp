/** Spend guardrails — pure so they're trivially testable. */

export interface SpendConfig {
  maxPerCallUsd: number;
  maxSessionUsd: number;
}

export interface SpendState {
  sessionSpentUsd: number;
  /** Authorized but not yet confirmed. The cap check happens before a network
   *  round trip and the increment happens after, so without a reservation two
   *  concurrent tool calls both read the same stale total and both pass. MCP
   *  clients batch tool calls routinely, so this is ordinary operation, not an
   *  attack: six parallel $1.00 calls cleared a $2.00 cap and spent $6.00. */
  pendingUsd: number;
}

/** Conservatively book an authorization that settled or may have settled.
 * Called before response-body reads so a truncated body cannot erase spend. */
export function bookAuthorizedSpend(state: SpendState, amountUsd: number): void {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) throw new Error("invalid spend amount");
  state.sessionSpentUsd += amountUsd;
}

/** A paid wrapper can return a 5xx after dispatching settlement but before a
 * definitive receipt arrives. Treat that response as possibly paid even when
 * an intermediary stripped the gateway's x-payment-state header. */
export function paymentAccountingState(
  status: number,
  receiptConfirmsSettlement: boolean,
  explicitState: string | null,
): "paid" | "ambiguous" | "unpaid" {
  if (receiptConfirmsSettlement || status === 200) return "paid";
  if (explicitState === "ambiguous" || status >= 500) return "ambiguous";
  return "unpaid";
}

export interface PaymentExpectation {
  /** Manifest price, converted to USDC's six-decimal atomic units. */
  amountAtomic: bigint;
  network: string;
  asset: string;
  payTo: string;
}

export interface PaymentRequirementLike {
  scheme: string;
  network: string;
  amount?: string;
  asset: string;
  payTo: string;
}

/** Parse a manifest USD price without floating-point rounding. The gateway
 *  settles in USDC (six decimals), so sub-micro-dollar prices are refused. */
export function parsePriceAtomic(price: string): bigint | null {
  const raw = price.trim().replace(/^\$/, "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw)) return null;
  const [whole = "", fraction = ""] = raw.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

/** Select only a requirement that is byte-for-byte consistent with the
 *  manifest price and payment identity. This function is called by x402
 *  immediately before it creates a wallet signature; the free manifest alone
 *  is never treated as authorization to spend. */
export function selectBoundPaymentRequirement<T extends PaymentRequirementLike>(
  x402Version: number,
  requirements: T[],
  expected: PaymentExpectation,
): T {
  if (x402Version !== 2) throw new Error("Refused payment: only x402 v2 is supported");
  const match = requirements.find((r) => {
    if (r.scheme !== "exact" || r.amount === undefined || !/^\d+$/.test(r.amount)) return false;
    return (
      BigInt(r.amount) === expected.amountAtomic &&
      r.network === expected.network &&
      r.asset.toLowerCase() === expected.asset.toLowerCase() &&
      r.payTo.toLowerCase() === expected.payTo.toLowerCase()
    );
  });
  if (!match) {
    throw new Error(
      "Refused payment: the live 402 amount or destination does not match the trusted manifest",
    );
  }
  return match;
}

export function parsePriceUsd(price: string): number | null {
  // Trim first: " $0.005" used to fail the ^\$ anchor and parse as NaN.
  const raw = price.trim().replace(/^\$/, "").trim();
  // "" and "$" are an ABSENT price, not a price of zero. Number("") is 0, so
  // the earlier version scored such an entry as free and waved it past both
  // caps — a remote manifest could register a tool that cost anything.
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Returns null when the call may proceed, or a refusal message the agent can relay. */
export function checkSpend(
  priceUsd: number,
  state: SpendState,
  config: SpendConfig,
): string | null {
  // A cap that is not a finite number is a MISCONFIGURATION, never "no limit".
  // Number("$0.25") is NaN and every comparison against NaN is false, so an
  // unguarded cap of "$0.25" admitted a $1.00 call. This package prints every
  // price with a leading $ — in the README, in each tool description, and in
  // the refusal text below — so that is the typo to expect, and it silently
  // removed the only thing standing between an agent and the user's wallet.
  if (!Number.isFinite(config.maxPerCallUsd) || !Number.isFinite(config.maxSessionUsd)) {
    return (
      "Refused: spend caps are misconfigured. MAX_PER_CALL_USD and MAX_SESSION_USD " +
      "must be plain numbers (0.25), not currency strings (\"$0.25\"). " +
      "Refusing to pay anything until they are valid."
    );
  }
  if (priceUsd > config.maxPerCallUsd) {
    return (
      `Refused: this tool costs $${priceUsd} per call, above the MAX_PER_CALL_USD cap of ` +
      `$${config.maxPerCallUsd}. Raise the cap in the MCP server env if this is intended.`
    );
  }
  // Committed = already settled PLUS authorized-and-in-flight. Counting only
  // the settled total let concurrent calls each pass against the same figure.
  const committed = state.sessionSpentUsd + state.pendingUsd;
  if (committed + priceUsd > config.maxSessionUsd) {
    return (
      `Refused: paying $${priceUsd} would bring this session's spend to ` +
      `$${(committed + priceUsd).toFixed(3)}, above the MAX_SESSION_USD cap of ` +
      `$${config.maxSessionUsd}. Session spend so far: $${state.sessionSpentUsd.toFixed(3)}` +
      `${state.pendingUsd > 0 ? ` (plus $${state.pendingUsd.toFixed(3)} in flight)` : ""}. ` +
      `The cap is set by the user in this server's environment.`
    );
  }
  return null;
}
