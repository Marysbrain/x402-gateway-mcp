/** Spend guardrails — pure so they're trivially testable. */
export function parsePriceUsd(price) {
    const n = Number(price.replace(/^\$/, ""));
    return Number.isFinite(n) && n >= 0 ? n : null;
}
/** Returns null when the call may proceed, or a refusal message the agent can relay. */
export function checkSpend(priceUsd, state, config) {
    if (priceUsd > config.maxPerCallUsd) {
        return (`Refused: this tool costs $${priceUsd} per call, above the MAX_PER_CALL_USD cap of ` +
            `$${config.maxPerCallUsd}. Raise the cap in the MCP server env if this is intended.`);
    }
    if (state.sessionSpentUsd + priceUsd > config.maxSessionUsd) {
        return (`Refused: paying $${priceUsd} would bring this session's spend to ` +
            `$${(state.sessionSpentUsd + priceUsd).toFixed(3)}, above the MAX_SESSION_USD cap of ` +
            `$${config.maxSessionUsd}. Session spend so far: $${state.sessionSpentUsd.toFixed(3)}. ` +
            `Restart the MCP server or raise the cap to continue.`);
    }
    return null;
}
