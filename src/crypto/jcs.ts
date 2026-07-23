/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * Object keys are sorted by their UTF-16 code units, insignificant whitespace is
 * dropped, and primitives are serialized exactly as ECMAScript's JSON.stringify
 * does — which RFC 8785 §3.2.2 explicitly adopts for numbers and strings.
 *
 * Everything that gets signed or hashed in Heron passes through here first, so
 * that a third party can recompute the exact bytes we signed without talking
 * to us.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export function canonicalize(value: unknown): string {
  const out = serialize(value);
  if (out === undefined) {
    throw new TypeError("Value is not representable in canonical JSON");
  }
  return out;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function serialize(value: unknown): string | undefined {
  if (value === null) return "null";

  const type = typeof value;

  if (type === "boolean") return value ? "true" : "false";

  if (type === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(`Non-finite number cannot be canonicalized: ${n}`);
    }
    // JSON.stringify implements ECMAScript Number::toString, which RFC 8785 mandates.
    return JSON.stringify(n);
  }

  if (type === "string") return JSON.stringify(value);

  if (type === "bigint") {
    throw new TypeError("BigInt cannot be canonicalized");
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => serialize(item) ?? "null");
    return `[${items.join(",")}]`;
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    // Sort by UTF-16 code units — the default lexicographic order of Array#sort.
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const serialized = serialize(obj[key]);
      if (serialized === undefined) continue; // undefined members are dropped, as in JSON.stringify
      parts.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${parts.join(",")}}`;
  }

  return undefined; // undefined, function, symbol
}
