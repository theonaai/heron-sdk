import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * This package is installed by vendors we do not run, so its import graph may not reach a server: no
 * database, no env, no signing keys, and — because the vendor's runtime may be a Deno edge function,
 * a Cloudflare Worker or a browser bundle — no `node:*` built-in either. `HeronClient` transitively
 * importing Prisma is not a style nit: a vendor who runs `npm i @theonaai/heron-sdk` would install a
 * database client, and any accidental import into a browser bundle would pull the server in with it.
 *
 * This walks the graph statically from the public entrypoints and fails if a forbidden module becomes
 * reachable. It is the invariant that keeps the package publishable, and it now lives in the package's
 * own repository — where a change to the source is made.
 */

const ROOT = process.cwd();
const ENTRYPOINTS = [
  "src/index.ts",
  "src/vendor-sdk.ts",
  "src/vendor-guard.ts",
  "src/contract.ts",
];

/** Names that would drag a server in. If one ever appears here, an import reached it. */
const FORBIDDEN_MODULES = new Set(["db.ts", "env.ts", "keys.ts"]);

function resolveImport(fromFile: string, spec: string): string | null {
  // Only follow relative imports — packages (@noble) and node: builtins are external.
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every local .ts file reachable from the entrypoints, following relative imports only. */
function reachableFrom(entrypoints: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = entrypoints.map((e) => join(ROOT, e));
  const importRe = /from\s+["'](\.[^"']+)["']/g;

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importRe)) {
      const target = resolveImport(file, match[1]!);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return seen;
}

describe("vendor SDK stays portable", () => {
  const reachable = reachableFrom(ENTRYPOINTS);
  const relPaths = [...reachable].map((f) => relative(ROOT, f));

  it("reaches none of the server-only modules", () => {
    const leaked = relPaths.filter((p) => FORBIDDEN_MODULES.has(p.split("/").pop()!));
    expect(leaked).toEqual([]);
  });

  it("imports no database client anywhere in its graph", () => {
    const withPrisma = relPaths.filter((p) => readFileSync(join(ROOT, p), "utf8").includes("@prisma/"));
    expect(withPrisma).toEqual([]);
  });

  /**
   * Server-free was never the whole requirement — runtime-free is. Every primitive the SDK needs has
   * a portable implementation (`@noble/*`, WebCrypto, `fetch`), so a `node:*` import costs nothing to
   * forbid and quietly excludes a class of vendor the moment it is allowed.
   */
  it("reaches no Node built-in, so it runs wherever the vendor runs", () => {
    const nodeBuiltin = /from\s+["']node:([^"']+)["']/g;
    const offenders = relPaths.flatMap((p) => {
      const source = readFileSync(join(ROOT, p), "utf8");
      return [...source.matchAll(nodeBuiltin)].map((m) => `${p} → node:${m[1]}`);
    });
    expect(offenders).toEqual([]);
  });

  it("still covers the modules it is supposed to (the walk actually ran)", () => {
    // A guard against the walk silently reaching nothing and passing vacuously.
    for (const expected of [
      "src/vendor-sdk.ts",
      "src/vendor-guard.ts",
      "src/statements.ts",
      "src/pseudonym-core.ts",
      "src/crypto/ed25519.ts",
    ]) {
      expect(relPaths).toContain(expected);
    }
  });
});
