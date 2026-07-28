import type { SignalKey } from "./contract";
import { hashCanonical } from "./crypto/hash";
import type { DataClass, Destination, Operation, Reversibility } from "./policy/taxonomy";

/**
 * The tool catalogue — the vendor's signed statement of what its tools *are*.
 *
 * A `signals` object describes one *call*. This describes one *tool*, and the difference is the
 * whole reason the file exists. Where the vendor states nothing, Heron derives the dimension from
 * the tool's name and publishes it as `source: "derived"` — which reads to a reviewer as an
 * independent inference and is not one: the name is a string the audited party chose, nothing binds
 * it to what the tool does, and MCP's own ecosystem treats it as attackable (serve a safe
 * definition, get approved, replace it through `notifications/tools/list_changed`). A catalogue is
 * that same knowledge said once under the vendor's key, dated, and published to the reviewer in
 * full. It does not make the claim true — a catalogue can be wrong exactly as a signal can. What
 * changes is that being wrong becomes something the reviewer can *find*, and a rename becomes an
 * event rather than a silent change of verdict.
 *
 * **It lives in the SDK because the bytes have to agree.** The vendor signs the canonical catalogue
 * and Heron verifies the same bytes; a sort order or a dropped key that differs between the two is
 * not a failing test on the server, it is an `INVALID_VENDOR_SIGNATURE` finding published against
 * the vendor. That is the argument that moved `canonicalize()` here, applied one level up: one
 * implementation, shared by the party that signs and the party that checks.
 *
 * **What belongs in it, and what does not.** Only facts that are constant for the tool. A recipient
 * count, an amount, a human's approval are facts about one call and stay in that call's `signals`,
 * which always win over the catalogue. `destination` sits on the line and is allowed deliberately:
 * for a great many tools it genuinely is constant (a people-enrichment API is always third-party, an
 * internal memory write is always internal), and it is the single most decisive missing dimension
 * measured in production. State it only where it really is constant.
 *
 * Pure: shape and hashing only. Transport is `HeronClient.publishToolCatalog`.
 */

/**
 * The signal keys a catalogue may carry — the ones whose truth is a property of the tool.
 *
 * Typed against `SignalKey`, so a key the classifier does not read will not compile: the boundary
 * contract stays one vocabulary (`./contract`), and a catalogue is a different *scope* for it, never
 * a second dialect.
 */
export const CATALOG_SIGNAL_KEYS = [
  "op",
  "data_class",
  "destination",
  "reversible",
  "reversibility",
] as const satisfies readonly SignalKey[];

export type CatalogSignalKey = (typeof CATALOG_SIGNAL_KEYS)[number];

/**
 * What a catalogue may say about a tool. Typed against the taxonomy rather than against loose
 * strings, minus `unknown` on each dimension: "we do not know" is said by leaving the key out, and a
 * catalogue that asserts `unknown` would be claiming a fact about the tool that is really a fact
 * about the vendor's own certainty.
 */
export interface CatalogSignals {
  op?: Exclude<Operation, "unknown">;
  data_class?: Exclude<DataClass, "unknown">;
  destination?: Exclude<Destination, "unknown">;
  /** Two-valued shorthand. Where the honest answer is `costly`, use `reversibility`. */
  reversible?: boolean;
  reversibility?: Exclude<Reversibility, "unknown">;
}

export interface CatalogEntry {
  /** The tool name exactly as it arrives on an action — the join key, so it must match verbatim. */
  name: string;
  /** Absent keys are not claimed; an empty entry states nothing and is legal. */
  signals: CatalogSignals;
  /** The vendor's own routing, when it has it. Recorded for the reviewer, never matched on. */
  provider?: string;
  server?: string;
}

export interface ToolCatalog {
  v: 1;
  /** Sorted by name, so two vendors stating the same facts produce the same hash. */
  tools: CatalogEntry[];
}

/**
 * Canonicalise a catalogue: sort the tools by name, keep only the catalogue keys, drop absent
 * optionals.
 *
 * The hash is what the vendor signs and what a reviewer compares against, so two statements of the
 * same facts have to produce the same bytes — otherwise re-uploading an unchanged catalogue looks
 * like a change, and a real change is indistinguishable from a re-ordering. A vendor whose tool
 * registry iterates a map has no stable order to offer, and must not be publishing a "change"
 * because of it.
 */
export function buildToolCatalog(entries: readonly CatalogEntry[]): ToolCatalog {
  const tools = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      signals: Object.fromEntries(
        CATALOG_SIGNAL_KEYS.filter((key) => entry.signals[key] !== undefined).map((key) => [
          key,
          entry.signals[key],
        ]),
      ) as CatalogSignals,
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.server ? { server: entry.server } : {}),
    }));
  return { v: 1, tools };
}

/** `catalog_hash` — sha256 over the canonical (RFC 8785) catalogue, the same way `policy_hash` is. */
export function catalogHash(catalog: ToolCatalog): string {
  return hashCanonical(catalog);
}

/**
 * What the catalogue says about one tool, by exact name.
 *
 * Deliberately *not* the group-key matching the contract map uses (globs, `provider:`, `server:`).
 * That resolution is a convenience for writing a configuration; a catalogue is the *result* of
 * writing one — the vendor expands its own groups before signing, so what crosses is a statement
 * about each tool by name, and a reviewer applying the catalogue to a published action never has to
 * reimplement anyone's precedence rules to check it.
 */
export function resolveCatalogEntry(
  catalog: ToolCatalog | null,
  toolName: string,
): CatalogEntry | null {
  if (!catalog) return null;
  return catalog.tools.find((entry) => entry.name === toolName) ?? null;
}
