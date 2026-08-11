import type { SignalKey } from "./contract";
import { hashCanonical } from "./crypto/hash";
import { byCodeUnit } from "./order";
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
  /**
   * Other names this same tool has arrived under — *the vendor's statement*, not our guess.
   *
   * A vendor that renames a tool leaves its old traffic behind permanently: the join is verbatim
   * because the name is what they signed, so renaming forward describes nothing that already ran.
   * Measured on Theona's 10.08 window, that is 2 919 calls across 85 tools missing the catalogue on
   * letter case alone — `execute_agent` against `EXECUTE_AGENT` being 1 410 of them.
   *
   * The alternative was normalising on receipt (lowercase both sides, strip separators), and it is
   * the thing this key exists to avoid: matching a signed name loosely is how a signature stops
   * meaning anything, and it would silently merge two tools a vendor deliberately spells apart. So
   * the vendor says it instead — "this tool was also known as X" — inside the bytes they sign, dated
   * by the catalogue it arrives in and published to the reviewer with everything else. Being wrong
   * about an alias is then a claim someone can find, exactly like being wrong about `data_class`.
   */
  aliases?: string[];
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
 * The aliases an entry actually states: de-duplicated, and without the entry's own name.
 *
 * Shared by the canonicalisation and the door-check on purpose. Saying a name twice says it once,
 * and a tool listing its own name as an alias is a statement with no content — but the two functions
 * only stay in agreement about that if they read the key through the same filter. They are not
 * always reading a catalogue we built: `catalogAliasConflicts` runs over whatever bytes arrived, and
 * a hand-signed one repeating an alias would otherwise be refused as `ambiguous` over a repetition
 * `resolveCatalogEntry` reads straight through.
 */
function statedAliases(entry: CatalogEntry): string[] {
  return [...new Set(entry.aliases ?? [])].filter((alias) => alias !== entry.name);
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
 *
 * `aliases` gets the same treatment for the same reason — sorted, de-duplicated, and dropped
 * entirely when it says nothing. That last part is what keeps this a `v: 1` addition rather than a
 * format break: a catalogue stating no aliases canonicalises to the bytes it always did, so every
 * hash a receipt already names still resolves to the catalogue it named.
 */
export function buildToolCatalog(entries: readonly CatalogEntry[]): ToolCatalog {
  const tools = [...entries]
    .sort((a, b) => byCodeUnit(a.name, b.name))
    .map((entry) => {
      const aliases = statedAliases(entry).sort(byCodeUnit);

      return {
        name: entry.name,
        ...(aliases.length ? { aliases } : {}),
        signals: Object.fromEntries(
          CATALOG_SIGNAL_KEYS.filter((key) => entry.signals[key] !== undefined).map((key) => [
            key,
            entry.signals[key],
          ]),
        ) as CatalogSignals,
        ...(entry.provider ? { provider: entry.provider } : {}),
        ...(entry.server ? { server: entry.server } : {}),
      };
    });
  return { v: 1, tools };
}

/** `catalog_hash` — sha256 over the canonical (RFC 8785) catalogue, the same way `policy_hash` is. */
export function catalogHash(catalog: ToolCatalog): string {
  return hashCanonical(catalog);
}

/**
 * What the catalogue says about one tool: by exact name, and failing that by an alias the vendor
 * declared for it.
 *
 * Deliberately *not* the group-key matching the contract map uses (globs, `provider:`, `server:`).
 * That resolution is a convenience for writing a configuration; a catalogue is the *result* of
 * writing one — the vendor expands its own groups before signing, so what crosses is a statement
 * about each tool by name, and a reviewer applying the catalogue to a published action never has to
 * reimplement anyone's precedence rules to check it. An alias does not weaken that: it is still an
 * exact string comparison against a name the vendor signed, only against a name they said belongs
 * to this tool as well.
 *
 * Two passes, and the order is the whole point. **A live name always beats somebody else's alias**,
 * so a vendor that retires `X` and later ships a genuinely different tool called `X` gets the new
 * tool's own entry — never the old one's inherited description, which is the one way an alias could
 * quietly attach the wrong facts to a call.
 *
 * **An alias claimed by two entries resolves to nothing.** This function is pure and total by
 * contract: a reviewer runs it offline over whatever bytes were published, including a catalogue
 * whose aliases contradict each other. Picking the first match there would make the answer depend on
 * sort order, which is to say on a detail nobody signed; answering `null` says what is actually
 * true — the catalogue does not determine this tool — and leaves the call classified from its name,
 * exactly as an unlisted tool is. `PUT /v1/tool-catalog` refuses such a catalogue at the door, so
 * this branch is the reviewer's guarantee rather than the normal path.
 */
export function resolveCatalogEntry(
  catalog: ToolCatalog | null,
  toolName: string,
): CatalogEntry | null {
  if (!catalog) return null;

  const byName = catalog.tools.find((entry) => entry.name === toolName);
  if (byName) return byName;

  const byAlias = catalog.tools.filter((entry) => entry.aliases?.includes(toolName));
  return byAlias.length === 1 ? (byAlias[0] ?? null) : null;
}

/**
 * The aliases a catalogue states that cannot be honoured, with why — the check `PUT
 * /v1/tool-catalog` runs before it stores anything.
 *
 * It lives here, next to the resolution it protects, because the two have to agree about what an
 * alias means; a server-side copy of this rule is one refactor away from accepting a catalogue the
 * reviewer's `resolveCatalogEntry` then reads differently. Empty means every alias resolves.
 *
 * `shadowed` is reported and *not* an error: a vendor whose old name is now a live tool has stated
 * something we simply cannot honour, and the resolution above already says which side wins. It is
 * worth telling them; it is not worth refusing a catalogue over, because the alternative is a vendor
 * unable to publish anything about their current tools until they clean up their history.
 *
 * **`shadowed` is therefore tested first**, and that order is the rule, not a detail. An alias that
 * is both claimed twice *and* the name of a live tool is not ambiguous: `resolveCatalogEntry` never
 * reaches its alias pass, because the live name already answered. Reporting the fatal reason for a
 * case resolution fully determines would refuse a catalogue over nothing — the same vendor stuck
 * with their own rename history that the non-fatal rule exists to release.
 */
export function catalogAliasConflicts(catalog: ToolCatalog): Array<{
  alias: string;
  reason: "ambiguous" | "shadowed";
  claimedBy: string[];
}> {
  const claims = new Map<string, string[]>();
  for (const entry of catalog.tools) {
    for (const alias of statedAliases(entry)) {
      claims.set(alias, [...(claims.get(alias) ?? []), entry.name]);
    }
  }

  const names = new Set(catalog.tools.map((entry) => entry.name));
  const conflicts: Array<{ alias: string; reason: "ambiguous" | "shadowed"; claimedBy: string[] }> =
    [];
  for (const [alias, claimedBy] of claims) {
    if (names.has(alias)) {
      conflicts.push({ alias, reason: "shadowed", claimedBy: [...claimedBy].sort(byCodeUnit) });
    } else if (claimedBy.length > 1) {
      conflicts.push({ alias, reason: "ambiguous", claimedBy: [...claimedBy].sort(byCodeUnit) });
    }
  }

  return conflicts.sort((a, b) => byCodeUnit(a.alias, b.alias));
}
