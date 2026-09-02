import { createHash, webcrypto } from "node:crypto";
export const MANIFEST_SIGNATURE_HEADER = "x-stride20k-signature";
export const SIGNING_KEY_PATH = "/.well-known/signing-key.json";
// Production key observed 2026-08-31. Rotation is deliberately a client
// release: an unexpected key must not be allowed to redefine payment policy.
export const DEFAULT_EXPECTED_SIGNING_KID = "SUV3J4jHSPM0kbSKjh-nhZV6eM78E3rnoaonFvTyzyU";
export function parseManifestSignature(value) {
    const fields = new Map();
    for (const part of value.split(";")) {
        const at = part.indexOf("=");
        if (at <= 0)
            throw new Error("manifest signature header is malformed");
        const key = part.slice(0, at).trim();
        const fieldValue = part.slice(at + 1).trim();
        if (!key || !fieldValue || fields.has(key)) {
            throw new Error("manifest signature header is malformed");
        }
        fields.set(key, fieldValue);
    }
    const parsed = {
        v: fields.get("v") ?? "",
        alg: fields.get("alg") ?? "",
        kid: fields.get("kid") ?? "",
        sig: fields.get("sig") ?? "",
    };
    if (fields.size !== 4 || parsed.v !== "1" || parsed.alg !== "ES256" || !parsed.kid || !parsed.sig) {
        throw new Error("manifest signature header is unsupported");
    }
    return parsed;
}
function jwkThumbprint(jwk) {
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return createHash("sha256").update(canonical).digest("base64url");
}
function decodeSignature(encoded) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new Error("manifest signature is not canonical base64");
    }
    const signature = Buffer.from(encoded, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== encoded) {
        throw new Error("manifest signature has the wrong encoding or length");
    }
    return signature;
}
/** Verify the exact manifest bytes against a compile-time/operator-pinned key. */
export async function verifyManifestSignature(body, signatureHeader, keyDocument, expectedKid) {
    if (!signatureHeader)
        throw new Error("gateway manifest is unsigned");
    if (!expectedKid)
        throw new Error("EXPECTED_SIGNING_KID must not be empty");
    const signature = parseManifestSignature(signatureHeader);
    if (signature.kid !== expectedKid)
        throw new Error("gateway manifest signing key is not trusted");
    const matching = keyDocument.keys?.filter((key) => key.kid === expectedKid) ?? [];
    if (matching.length !== 1)
        throw new Error("trusted manifest signing key is missing or duplicated");
    const jwk = matching[0];
    if (jwk.kty !== "EC" ||
        jwk.crv !== "P-256" ||
        typeof jwk.x !== "string" ||
        typeof jwk.y !== "string" ||
        (jwk.alg !== undefined && jwk.alg !== "ES256") ||
        (jwk.use !== undefined && jwk.use !== "sig") ||
        jwkThumbprint(jwk) !== expectedKid) {
        throw new Error("trusted manifest signing key document is invalid");
    }
    const publicKey = await webcrypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, decodeSignature(signature.sig), new TextEncoder().encode(body));
    if (!valid)
        throw new Error("gateway manifest signature verification failed");
}
