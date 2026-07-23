import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

import { canonicalBytes } from "./jcs";
import { fromHex, toHex } from "./encoding";

/** All hashes travel as `sha256:<hex>` so their algorithm is never implied. */
export const HASH_PREFIX = "sha256:";

export function sha256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return toHex(nobleSha256(bytes));
}

export function sha256Tagged(input: Uint8Array | string): string {
  return HASH_PREFIX + sha256Hex(input);
}

/** Hash of the canonical form of a value — the only way we hash structured data. */
export function hashCanonical(value: unknown): string {
  return sha256Tagged(canonicalBytes(value));
}

export function stripHashPrefix(tagged: string): string {
  return tagged.startsWith(HASH_PREFIX) ? tagged.slice(HASH_PREFIX.length) : tagged;
}

/**
 * One link of the session hash chain (AARM R2).
 *
 *   record_hash = SHA256( JCS(record) || prev_hash_bytes )
 *
 * `prev_hash` is folded in as raw bytes, so a chain cannot be re-anchored by
 * replaying a record under a different predecessor.
 */
export function chainRecordHash(record: unknown, prevHash: string): string {
  const recordBytes = canonicalBytes(record);
  const prevBytes = fromHex(stripHashPrefix(prevHash));
  const buf = new Uint8Array(recordBytes.length + prevBytes.length);
  buf.set(recordBytes, 0);
  buf.set(prevBytes, recordBytes.length);
  return sha256Tagged(buf);
}

/** The genesis link of a session chain: hash of the session's opening record. */
export function genesisHash(record: unknown): string {
  return hashCanonical(record);
}
