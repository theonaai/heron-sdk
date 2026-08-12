/** The durable agent fields for which a credential-shaped write deserves a human warning. */
export type CredentialWriteTarget = "instructions" | "memory" | "flow";

export type CredentialShape = "prefixed-token" | "long-hex" | "long-opaque-token" | "url-embedded-secret";

/**
 * A deliberately content-free warning. It is local SDK output, not a Heron policy signal: callers
 * may show or log the category, but cannot accidentally forward the credential that caused it.
 */
export interface CredentialWriteWarning {
  code: "credential-shaped-write";
  level: "warning";
  target: CredentialWriteTarget;
  shapes: CredentialShape[];
}

export interface CredentialWriteInput {
  target: CredentialWriteTarget;
  value: unknown;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const PREFIXED_TOKEN_PATTERN = /\b[A-Za-z]{2,12}[-_.]([A-Za-z0-9_-]{20,160})\b/g;
const LONG_HEX_PATTERN = /\b[A-Fa-f0-9]{32,160}\b/g;
const LONG_HEX_VALUE_PATTERN = /^[A-Fa-f0-9]{32,160}$/;
const LONG_OPAQUE_PATTERN = /\b[A-Za-z0-9+/_=-]{32,160}\b/g;
const UUID_PATTERN = /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/;

const MAX_DEPTH = 8;
const MAX_NODES = 2000;
const MAX_STRING_LENGTH = 200_000;

const SHAPE_ORDER: CredentialShape[] = [
  "prefixed-token",
  "long-hex",
  "long-opaque-token",
  "url-embedded-secret",
];

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);

  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function characterClasses(value: string): number {
  return [/[a-z]/, /[A-Z]/, /\d/, /[-_+/=]/].reduce(
    (count, pattern) => count + Number(pattern.test(value)),
    0,
  );
}

function isOpaque(value: string, minimumLength: number): boolean {
  return (
    value.length >= minimumLength &&
    value.length <= 160 &&
    !UUID_PATTERN.test(value) &&
    characterClasses(value) >= 2 &&
    entropy(value) >= 3.5
  );
}

function isUrlSecret(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const candidates = [
    ...url.pathname.split("/").filter(Boolean),
    ...Array.from(url.searchParams.values()),
  ];

  return candidates.some((candidate) => {
    let decoded = candidate;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      // A malformed escape is still safe to inspect in its original form.
    }
    return LONG_HEX_VALUE_PATTERN.test(decoded) || isOpaque(decoded, 24);
  });
}

function inspectString(input: string, shapes: Set<CredentialShape>): void {
  const text = input.slice(0, MAX_STRING_LENGTH);
  const withoutUrls = text.replace(URL_PATTERN, (url) => {
    if (isUrlSecret(url)) shapes.add("url-embedded-secret");
    return " ";
  });

  for (const match of withoutUrls.matchAll(PREFIXED_TOKEN_PATTERN)) {
    const run = match[1];
    if (run && characterClasses(run) >= 2 && entropy(run) >= 3.2) {
      shapes.add("prefixed-token");
    }
  }

  if (withoutUrls.match(LONG_HEX_PATTERN)) shapes.add("long-hex");
  for (const match of withoutUrls.matchAll(LONG_OPAQUE_PATTERN)) {
    if (
      LONG_HEX_VALUE_PATTERN.test(match[0]) ||
      /^[A-Za-z]{2,12}[-_.]/.test(match[0])
    ) {
      continue;
    }
    if (isOpaque(match[0], 32)) shapes.add("long-opaque-token");
  }
}

/**
 * Inspect a durable agent write for generic credential forms.
 *
 * The walk is bounded and cycle-safe because callers may hand this function an entire tool argument
 * object. The returned object contains only categories; matched strings, source text, object paths
 * and excerpts never leave this function.
 */
export function detectCredentialWrite(
  input: CredentialWriteInput,
): CredentialWriteWarning | undefined {
  const shapes = new Set<CredentialShape>();
  const seen = new WeakSet<object>();
  let budget = MAX_NODES;

  const walk = (value: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_DEPTH) return;
    budget -= 1;

    if (typeof value === "string") {
      inspectString(value, shapes);
      return;
    }
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      walk(child, depth + 1);
    }
  };

  walk(input.value, 0);
  if (shapes.size === 0) return undefined;

  return {
    code: "credential-shaped-write",
    level: "warning",
    target: input.target,
    shapes: SHAPE_ORDER.filter((shape) => shapes.has(shape)),
  };
}
