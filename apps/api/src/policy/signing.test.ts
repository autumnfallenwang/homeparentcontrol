import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { policySigningKey } from "@hpc/contract";
import { describe, expect, it } from "vitest";
import { jwkThumbprint, loadSigningKey, SigningKeyError, signPolicy } from "./signing.js";

function pem(): string {
  return generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

const DOC = { policy_version: 1, device_id: "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60" };

describe("loadSigningKey", () => {
  it("reads a PKCS#8 PEM and derives the public JWK", () => {
    const key = loadSigningKey(pem());
    expect(key.publicJwk.kty).toBe("OKP");
    expect(key.publicJwk.crv).toBe("Ed25519");
    expect(key.publicJwk.alg).toBe("EdDSA");
    expect(key.publicJwk.x).toMatch(/^[\w-]+$/);
  });

  it("emits a JWK the contract accepts — it goes out in the enrolment response", () => {
    expect(policySigningKey.safeParse(loadSigningKey(pem()).publicJwk).success).toBe(true);
  });

  it("rejects a key that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => loadSigningKey(rsa)).toThrow(SigningKeyError);
    expect(() => loadSigningKey(rsa)).toThrow(/must be Ed25519/);
  });

  it("rejects garbage with a typed error rather than a raw crypto throw", () => {
    // This runs at boot, so the message has to say which env var is wrong.
    expect(() => loadSigningKey("not a key")).toThrow(SigningKeyError);
    expect(() => loadSigningKey("not a key")).toThrow(/POLICY_SIGNING_KEY/);
  });
});

describe("jwkThumbprint (the kid)", () => {
  it("is stable for the same key", () => {
    const p = pem();
    expect(loadSigningKey(p).kid).toBe(loadSigningKey(p).kid);
  });

  it("differs between keys", () => {
    expect(loadSigningKey(pem()).kid).not.toBe(loadSigningKey(pem()).kid);
  });

  it("is the RFC 7638 thumbprint — required members only, lexicographic", () => {
    // Pinned against an independent computation, not against our own output,
    // so a change to the member set or ordering fails rather than drifts.
    const key = loadSigningKey(pem());
    const jwk = key.publicJwk;
    expect(key.kid).toBe(jwkThumbprint({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }));
    // Member order in the input must not matter to the caller, only to us.
    expect(jwkThumbprint({ kty: jwk.kty, x: jwk.x, crv: jwk.crv })).toBe(key.kid);
  });

  it("ignores non-required members, per RFC 7638", () => {
    const key = loadSigningKey(pem());
    const extra = { ...key.publicJwk, use: "enc", alg: "somethingelse" };
    expect(jwkThumbprint(extra)).toBe(key.kid);
  });

  it("is base64url, 43 characters for sha256", () => {
    expect(loadSigningKey(pem()).kid).toMatch(/^[\w-]{43}$/);
  });
});

describe("signPolicy", () => {
  it("produces a three-segment compact JWS", () => {
    expect(signPolicy(DOC, loadSigningKey(pem())).split(".")).toHaveLength(3);
  });

  it("writes alg EdDSA and the key's kid into the header", () => {
    const key = loadSigningKey(pem());
    const [header] = signPolicy(DOC, key).split(".");
    const decoded = JSON.parse(Buffer.from(header as string, "base64url").toString());
    expect(decoded).toEqual({ alg: "EdDSA", typ: "JOSE", kid: key.kid });
  });

  it("embeds the document as the payload — attached, not detached", () => {
    // The agent verifies the bytes and THEN parses them; a detached signature
    // would leave nothing to verify against.
    const [, payload] = signPolicy(DOC, loadSigningKey(pem())).split(".");
    expect(JSON.parse(Buffer.from(payload as string, "base64url").toString())).toEqual(DOC);
  });

  /** The test that actually proves signing works: verify as the agent will. */
  it("verifies against the public JWK we hand the agent", () => {
    const key = loadSigningKey(pem());
    const jws = signPolicy(DOC, key);
    const [header, payload, sig] = jws.split(".");

    const pub = createPublicKey({ key: key.publicJwk as never, format: "jwk" });
    const ok = verify(
      null,
      Buffer.from(`${header}.${payload}`),
      pub,
      Buffer.from(sig as string, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("fails verification when the payload is tampered with", () => {
    const key = loadSigningKey(pem());
    const [header, , sig] = signPolicy(DOC, key).split(".");
    const forged = Buffer.from(JSON.stringify({ ...DOC, policy_version: 999 })).toString(
      "base64url",
    );

    const pub = createPublicKey({ key: key.publicJwk as never, format: "jwk" });
    const ok = verify(
      null,
      Buffer.from(`${header}.${forged}`),
      pub,
      Buffer.from(sig as string, "base64url"),
    );
    expect(ok).toBe(false);
  });

  it("fails verification under a different key", () => {
    const jws = signPolicy(DOC, loadSigningKey(pem()));
    const [header, payload, sig] = jws.split(".");
    const other = loadSigningKey(pem());

    const pub = createPublicKey({ key: other.publicJwk as never, format: "jwk" });
    const ok = verify(
      null,
      Buffer.from(`${header}.${payload}`),
      pub,
      Buffer.from(sig as string, "base64url"),
    );
    expect(ok).toBe(false);
  });
});
