import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Deterministic pseudonyms for the values redaction used to erase — the pure core.
 *
 * Erasure destroys the one thing an intent check needs: comparability. "Send the report to Maria"
 * followed by `email.send(to: <redacted:email>)` cannot be checked against itself — both sides of the
 * comparison collapsed into the same placeholder. A keyed HMAC keeps them equal when the underlying
 * values are equal, and tells us nothing about what they are.
 *
 * The token is not reversible without the key. What it does *not* protect against is a dictionary
 * attack by whoever holds the key: emails live in a small enough space that HMAC(secret, address) can
 * be recomputed and matched. So the key never reaches the database (a dump is inert without it).
 *
 * This module takes the secret as an argument and reaches nothing but `@noble/hashes`, so the vendor
 * SDK can tokenise in its own middleware (`HeronClient.anchor`) — the address then never crosses the
 * network at all. The env-bound convenience (`pseudonym()`, our own second-layer pass) lives in
 * src/lib/pseudonym.ts, which is server-only and must stay out of the SDK's import graph.
 *
 * `node:crypto` would have been the obvious choice and is the wrong one: this file ships inside a
 * package installed by vendors we do not run, and the ones on Deno, Workers or a browser bundle would
 * fail to import it. HMAC-SHA256 is HMAC-SHA256, so the tokens are byte-identical either way — which
 * matters, because a token that changed would silently stop matching every one already stored.
 */

/** Anchors: values an intent check compares across a session. */
export type AnchorType = "email" | "phone";

/**
 * Both sides of the integration match anchors with these — the vendor's middleware before sending,
 * and our redaction pass after. Two dialects of "what is an email" would produce two different tokens
 * for one address, and the comparison this whole mechanism exists for would quietly stop working.
 */
export const ANCHOR_PATTERNS: Array<{ type: AnchorType; re: RegExp }> = [
  { type: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { type: "phone", re: /\+\d[\d\s()-]{7,}\d/g },
];

/** Replace every anchor in `text` with whatever `token` returns for it. */
export function replaceAnchors(
  text: string,
  token: (type: AnchorType, value: string) => string,
): string {
  let out = text;
  for (const { type, re } of ANCHOR_PATTERNS) {
    out = out.replace(re, (match) => token(type, match));
  }
  return out;
}

/**
 * The tokens for every anchor in `text`, and nothing else — no prose, not even the
 * gaps between them.
 *
 * This is what a request is allowed to become when it crosses a boundary. The
 * comparison the request exists for — "did the agent write to the person the user
 * named?" — is a set intersection between these tokens and the ones in the
 * arguments; the words around them add nothing to it and are somebody's private
 * conversation. Deduplicated, because naming an address twice is not a second
 * recipient.
 */
export function collectAnchors(
  text: string,
  token: (type: AnchorType, value: string) => string,
): string[] {
  const tokens = new Set<string>();
  for (const { type, re } of ANCHOR_PATTERNS) {
    for (const match of text.matchAll(re)) {
      tokens.add(token(type, match[0]));
    }
  }
  return [...tokens];
}

const TOKEN_CHARS = 16; // 64 bits — a collision would read as "same recipient", so not 8.

/**
 * @param scope Separates key-holders that share a secret. On our side that is the organization id:
 *              with one key and a global scope, one org's token would be an oracle for another org's
 *              data. A vendor holding its own key is already isolated by the key and passes a constant.
 */
export function pseudonymWith(
  secret: string,
  type: AnchorType,
  value: string,
  scope: string,
): string {
  const normalized = value.trim().toLowerCase();
  const digest = bytesToHex(
    hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`${scope}|${type}|${normalized}`)),
  ).slice(0, TOKEN_CHARS);

  return `<${type}:${digest}>`;
}
