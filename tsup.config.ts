import { defineConfig } from "tsup";

// One entry per public export path, so each subpath in package.json's `exports` gets its own
// `.js`/`.cjs`/`.d.ts`. The app that operates Heron deep-imports the crypto/contract/taxonomy core
// back through these subpaths, so a missing per-subpath declaration is a real break, not a nicety —
// `tests/sdk-portable.test.ts` holds the graph server-free, and CI runs `tsc` + `npm pack --dry-run`.
// `@noble/*` stay external (declared dependencies); everything else the SDK uses is pure and inlined.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract.ts",
    "edge-classify": "src/edge-classify.ts",
    "pseudonym-core": "src/pseudonym-core.ts",
    statements: "src/statements.ts",
    "policy/taxonomy": "src/policy/taxonomy.ts",
    "crypto/jcs": "src/crypto/jcs.ts",
    "crypto/hash": "src/crypto/hash.ts",
    "crypto/ed25519": "src/crypto/ed25519.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
