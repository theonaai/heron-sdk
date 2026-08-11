/**
 * Order strings by UTF-16 code unit — `Array#sort`'s own default, and the order `canonicalize()`
 * puts object keys in (`./crypto/jcs`).
 *
 * Deliberately *not* `localeCompare()`. Its answer depends on the host's ICU locale and build:
 * `EXECUTE_AGENT` and `execute_agent` swap places between a default locale and `da_DK`, and a
 * runtime built `--without-intl` degrades to code units anyway. Anywhere an order decides what is
 * published or what is asserted, that makes the answer a property of the machine rather than of the
 * strings — and two replicas running identical code then disagree.
 *
 * It has two callers and they fail differently, which is why it is one function here rather than a
 * habit repeated in each:
 *
 * - `buildToolCatalog` sorts the bytes a vendor signs. A locale-dependent order means a different
 *   `catalog_hash`, a different `catalog:<hash>` idempotency key, and a published "change" that is
 *   only a re-ordering.
 * - `resolveContract` breaks ties between equally specific contract keys, which selects `keep` — the
 *   allowlist deciding what leaves the vendor's boundary at all. A locale-dependent order there is
 *   two replicas sending different fields for the same call. `ATTIO*FIND_RECORD` against
 *   `ATTIO_FIND_RECOR*` is ordered one way by every ICU locale and the other by a runtime built
 *   `--without-intl`, so the disagreement is between two builds of Node, not between two countries.
 */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
