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
