import { describe, expect, it } from "vitest";
import {
  checkSpend,
  bookAuthorizedSpend,
  paymentAccountingState,
  parsePriceAtomic,
  parsePriceUsd,
  selectBoundPaymentRequirement,
  type SpendConfig,
  type SpendState,
} from "../src/guards";

const cfg = (perCall: number, session: number): SpendConfig => ({
  maxPerCallUsd: perCall,
  maxSessionUsd: session,
});
const fresh = (): SpendState => ({ sessionSpentUsd: 0, pendingUsd: 0 });

describe("checkSpend — misconfigured caps", () => {
  // Number("$0.25") is NaN and NaN loses every comparison, so the unguarded
  // version authorized unlimited spending. Every price in this package is
  // printed with a leading $, so it is the typo users will actually make.
  it("refuses everything when a cap is not a finite number", () => {
    for (const bad of [Number("$0.25"), Number("abc"), Number("1e999"), -1]) {
      const refusal = checkSpend(1.0, fresh(), cfg(bad, 2));
      expect(refusal, `cap ${bad} must not authorize a payment`).toBeTruthy();
    }
  });

  it("refuses when the SESSION cap is the misconfigured one", () => {
    expect(checkSpend(0.001, fresh(), cfg(0.25, Number("$2.00")))).toBeTruthy();
  });

  it("a zero cap refuses rather than admits", () => {
    expect(checkSpend(0.001, fresh(), cfg(0, 2))).toBeTruthy();
  });
});

describe("checkSpend — in-flight reservations", () => {
  // The cap check and the spend increment straddle a network round trip. MCP
  // clients batch tool calls, so without counting reservations every call in a
  // batch clears the same stale total.
  it("counts in-flight calls against the session cap", () => {
    const state: SpendState = { sessionSpentUsd: 0, pendingUsd: 1.5 };
    expect(checkSpend(1.0, state, cfg(2, 2))).toBeTruthy();
  });

  it("simulated parallel batch cannot exceed the cap", () => {
    const state = fresh();
    const config = cfg(2, 2);
    let allowed = 0;
    // Six concurrent $1.00 calls: each reserves before the next check, exactly
    // as the server now does. Only two may proceed against a $2.00 cap.
    for (let i = 0; i < 6; i++) {
      if (checkSpend(1.0, state, config) === null) {
        state.pendingUsd += 1.0;
        allowed++;
      }
    }
    expect(allowed).toBe(2);
    expect(state.pendingUsd).toBeLessThanOrEqual(config.maxSessionUsd);
  });

  it("releasing a reservation frees the budget again", () => {
    const state: SpendState = { sessionSpentUsd: 0, pendingUsd: 2 };
    expect(checkSpend(1.0, state, cfg(2, 2))).toBeTruthy();
    state.pendingUsd = 0;
    expect(checkSpend(1.0, state, cfg(2, 2))).toBeNull();
  });
});

describe("conservative settlement accounting", () => {
  it("retains authorized spend before a later body-read failure", () => {
    const state = fresh();
    state.pendingUsd = 0.25;
    bookAuthorizedSpend(state, 0.25);
    state.pendingUsd -= 0.25;
    expect(state.sessionSpentUsd).toBe(0.25);
    expect(checkSpend(0.01, state, cfg(1, 0.25))).toBeTruthy();
  });

  it("retains budget for a receipt-less 502 because settlement may have landed", () => {
    expect(paymentAccountingState(502, false, null)).toBe("ambiguous");
    expect(paymentAccountingState(502, false, "ambiguous")).toBe("ambiguous");
    expect(paymentAccountingState(200, false, null)).toBe("paid");
    expect(paymentAccountingState(400, false, null)).toBe("unpaid");
  });
});

describe("checkSpend — ordinary limits", () => {
  it("allows a call at exactly the per-call cap", () => {
    expect(checkSpend(0.25, fresh(), cfg(0.25, 2))).toBeNull();
  });

  it("allows spend up to exactly the session cap, then refuses", () => {
    const state: SpendState = { sessionSpentUsd: 1.75, pendingUsd: 0 };
    expect(checkSpend(0.25, state, cfg(0.25, 2))).toBeNull();
    state.sessionSpentUsd = 2;
    expect(checkSpend(0.001, state, cfg(0.25, 2))).toBeTruthy();
  });

  it("refusal text does not coach the agent to raise the cap", () => {
    const refusal = checkSpend(1.0, fresh(), cfg(0.25, 2)) ?? "";
    expect(refusal.toLowerCase()).not.toContain("restart the mcp server");
  });
});

describe("parsePriceUsd", () => {
  it("accepts the advertised formats", () => {
    expect(parsePriceUsd("$0.005")).toBe(0.005);
    expect(parsePriceUsd("0.005")).toBe(0.005);
  });

  it("rejects anything it cannot price, so the caller fails closed", () => {
    for (const bad of ["$", "abc", "Infinity", "$-1", "$1_000"]) {
      expect(parsePriceUsd(bad), bad).toBeNull();
    }
  });
});

describe("402 requirement binding", () => {
  const expected = {
    amountAtomic: 5_000n,
    network: "eip155:8453",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    payTo: "0x552Cc4A10878C7F20574489D47184249657Ca3f6",
  };
  const valid = {
    scheme: "exact",
    amount: "5000",
    network: expected.network,
    asset: expected.asset,
    payTo: expected.payTo,
  };

  it("parses manifest prices exactly into six-decimal USDC units", () => {
    expect(parsePriceAtomic("$0.005")).toBe(5_000n);
    expect(parsePriceAtomic("1")).toBe(1_000_000n);
    expect(parsePriceAtomic("$0.0000001")).toBeNull();
    expect(parsePriceAtomic("1e-3")).toBeNull();
  });

  it("accepts only a v2 exact requirement matching amount, network, asset, and payTo", () => {
    expect(selectBoundPaymentRequirement(2, [valid], expected)).toBe(valid);
    for (const changed of [
      { ...valid, amount: "500000000" },
      { ...valid, network: "eip155:1" },
      { ...valid, asset: "0x0000000000000000000000000000000000000000" },
      { ...valid, payTo: "0x0000000000000000000000000000000000000000" },
      { ...valid, scheme: "upto" },
    ]) {
      expect(() => selectBoundPaymentRequirement(2, [changed], expected)).toThrow(/Refused payment/);
    }
    expect(() => selectBoundPaymentRequirement(1, [valid], expected)).toThrow(/only x402 v2/);
  });
});
