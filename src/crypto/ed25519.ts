import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

import { canonicalBytes } from "./jcs";
import { fromBase64Url, toBase64Url } from "./encoding";

// @noble/ed25519 ships without a hash implementation so it can stay dependency-free.
// Wiring it once, here, keeps every call site (server, worker, browser) identical.
ed.hashes.sha512 = sha512;

/**
 * Ed25519 over canonical JSON. The bytes that get signed are always `JCS(payload)` —
 * never a JavaScript object, never a re-serialized string. A third party can
 * recompute them from the payload we publish.
 */

export interface KeyPair {
  /** 32-byte Ed25519 seed. This is the secret; it never touches the database. */
  seed: Uint8Array;
  publicKey: Uint8Array;
}

export function keyPairFromSeed(seedBase64: string): KeyPair {
  const seed = new Uint8Array(Buffer.from(seedBase64, "base64"));
  if (seed.length !== 32) {
    throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  return { seed, publicKey: ed.getPublicKey(seed) };
}

export function generateSeedBase64(): string {
  return Buffer.from(ed.utils.randomSecretKey()).toString("base64");
}

export function signCanonical(payload: unknown, seed: Uint8Array): string {
  return toBase64Url(ed.sign(canonicalBytes(payload), seed));
}

export function verifyCanonical(
  payload: unknown,
  signatureBase64Url: string,
  publicKeyBase64Url: string,
): boolean {
  try {
    return ed.verify(
      fromBase64Url(signatureBase64Url),
      canonicalBytes(payload),
      fromBase64Url(publicKeyBase64Url),
    );
  } catch {
    // A malformed signature or key is a failed verification, not a crash.
    return false;
  }
}

/** JWK for a raw Ed25519 public key (RFC 8037). */
export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  kid: string;
  x: string;
  alg: "EdDSA";
  use: "sig";
}

export function publicKeyToJwk(kid: string, publicKeyBase64Url: string): Ed25519Jwk {
  return { kty: "OKP", crv: "Ed25519", kid, x: publicKeyBase64Url, alg: "EdDSA", use: "sig" };
}

export { toBase64Url, fromBase64Url };
