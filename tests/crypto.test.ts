import { describe, expect, it } from "vitest";

import {
  generateSeedBase64,
  keyPairFromSeed,
  publicKeyToJwk,
  signCanonical,
  toBase64Url,
  verifyCanonical,
} from "../src/crypto/ed25519";
import { chainRecordHash, hashCanonical } from "../src/crypto/hash";

describe("Ed25519 over canonical JSON", () => {
  const seed = generateSeedBase64();
  const { seed: seedBytes, publicKey } = keyPairFromSeed(seed);
  const publicKeyB64 = toBase64Url(publicKey);

  const payload = { v: 1, action: { id: "act_1", seq: 4 }, tool: "gmail.send" };

  it("verifies a signature it produced", () => {
    const signature = signCanonical(payload, seedBytes);
    expect(verifyCanonical(payload, signature, publicKeyB64)).toBe(true);
  });

  it("verifies regardless of key order — the signature is over the canonical form", () => {
    const signature = signCanonical(payload, seedBytes);
    const reordered = { tool: "gmail.send", action: { seq: 4, id: "act_1" }, v: 1 };
    expect(verifyCanonical(reordered, signature, publicKeyB64)).toBe(true);
  });

  it("rejects a payload that was altered after signing", () => {
    const signature = signCanonical(payload, seedBytes);
    const tampered = { ...payload, tool: "billing.refund" };
    expect(verifyCanonical(tampered, signature, publicKeyB64)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const other = keyPairFromSeed(generateSeedBase64());
    const signature = signCanonical(payload, other.seed);
    expect(verifyCanonical(payload, signature, publicKeyB64)).toBe(false);
  });

  it("treats a malformed signature as invalid rather than throwing", () => {
    expect(verifyCanonical(payload, "not-a-signature", publicKeyB64)).toBe(false);
  });

  it("publishes the public key as an RFC 8037 JWK", () => {
    const jwk = publicKeyToJwk("hk_test", publicKeyB64);
    expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: publicKeyB64 });
  });
});

describe("hash chain", () => {
  const prev = hashCanonical({ kind: "session", session: "ses_1" });

  it("links a record to its predecessor", () => {
    const record = { kind: "action", action: "act_1", seq: 0 };
    const hash = chainRecordHash(record, prev);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(chainRecordHash(record, prev)).toBe(hash); // deterministic
  });

  it("changes when the record changes", () => {
    const a = chainRecordHash({ kind: "action", tool: "gmail.send" }, prev);
    const b = chainRecordHash({ kind: "action", tool: "billing.refund" }, prev);
    expect(a).not.toBe(b);
  });

  it("changes when the predecessor changes — a record cannot be re-anchored", () => {
    const record = { kind: "action", tool: "gmail.send" };
    const other = hashCanonical({ kind: "session", session: "ses_2" });
    expect(chainRecordHash(record, prev)).not.toBe(chainRecordHash(record, other));
  });
});
