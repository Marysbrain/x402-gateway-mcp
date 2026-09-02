import { describe, expect, it } from "vitest";
import { buildTargetUrl } from "../src/url.js";

describe("paid target URL construction", () => {
  it("fails before payment when a required query input is absent", () => {
    expect(() => buildTargetUrl("https://gateway.example", {
      route: "/v1/preflight", method: "GET", inputSchema: { required: ["resource"] },
    }, {})).toThrow("missing required parameter: resource");
  });

  it("uses built path parameters for POST without leaking body fields into query", () => {
    expect(buildTargetUrl("https://gateway.example", {
      route: "/v1/check/:id", method: "POST", inputSchema: { required: ["id", "claim"] },
    }, { id: "a/b", claim: "rain" })).toBe("https://gateway.example/v1/check/a%2Fb");
  });
});
