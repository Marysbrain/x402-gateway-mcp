import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseManifestSignature, verifyManifestSignature } from "../src/manifest-trust.js";

const b64 = (value: ArrayBuffer) => Buffer.from(value).toString("base64");
const thumbprint = async (jwk: JsonWebKey) => {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Buffer.from(digest).toString("base64url");
};

async function signed(body: string) {
  const pair = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = await thumbprint(publicJwk);
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(body),
  );
  return {
    kid,
    header: `v=1; alg=ES256; kid=${kid}; sig=${b64(signature)}`,
    document: { keys: [{ ...publicJwk, kid, use: "sig", alg: "ES256" }] },
  };
}

describe("manifest trust", () => {
  it("verifies exact bytes with the pinned P-256 key", async () => {
    const body = JSON.stringify({ payment: { payTo: "0xabc" } });
    const fixture = await signed(body);
    await expect(verifyManifestSignature(body, fixture.header, fixture.document, fixture.kid)).resolves.toBeUndefined();
    await expect(verifyManifestSignature(body + " ", fixture.header, fixture.document, fixture.kid)).rejects.toThrow(
      /verification failed/,
    );
  });

  it("fails closed on unsigned, unpinned, malformed, and substituted keys", async () => {
    const fixture = await signed("{}");
    await expect(verifyManifestSignature("{}", null, fixture.document, fixture.kid)).rejects.toThrow(/unsigned/);
    await expect(verifyManifestSignature("{}", fixture.header, fixture.document, "other")).rejects.toThrow(/not trusted/);
    await expect(verifyManifestSignature("{}", fixture.header, { keys: [] }, fixture.kid)).rejects.toThrow(/missing/);
    expect(() => parseManifestSignature("v=2; alg=none; kid=x; sig=x")).toThrow(/unsupported/);
  });
});
