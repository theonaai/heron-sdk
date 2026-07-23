import type { SignalKey } from "./contract";
import { ANCHOR_PATTERNS } from "./pseudonym-core";

/**
 * The reference edge classifier — the five-dimension contract (src/lib/contract.ts) produced from a
 * call's *arguments*, on the vendor's side, so an integrator emits signals without hand-rolling them.
 *
 * The line it must not cross, and the reason this file is small:
 *
 * **It reads arguments, never the tool name.** Anything derivable from a tool name Heron already
 * derives itself (src/lib/policy/classify.ts), and publishes as `source: "derived"` — an honest
 * admission that it guessed. Sending that same guess as a *signal* would repaint it `declared`
 * without adding a bit of information, and `tallySignalSources()` (src/lib/policy/signal-sources.ts)
 * exists precisely to let a reviewer catch that substitution. A classifier we wrote does not become
 * verified by being ours. So this emits only facts that live in the arguments — which Heron never
 * sees (invariant #6) — and that is also why it can only run here.
 *
 * What it therefore covers is `magnitude` and `destination`: the two dimensions pinned to the
 * vendor's side (`derivable: "none"`), invisible from a tool name, and today almost always
 * `unknown`. What it deliberately leaves alone:
 *
 *   - `op` / `reversible` — Heron derives both from the tool name. Nothing here would improve them.
 *   - `data_class` — an email in the arguments does not distinguish a data subject's address from a
 *     service sender, and a `declared` signal *overrides* Heron's derivation: emitting `personal` on
 *     `payments.refund` because a receipt address is in the args would drop `financial` and take the
 *     call out of the money rule. The class of the data is domain knowledge; it stays the vendor's,
 *     in `ToolContract.signals`.
 *   - `resolves_action` / `human_decision` / `approver` — a human decided; no argument says so.
 *
 * Everything it emits is a floor, not a ceiling: `openGuardedSession` merges a tool's own
 * `contract.signals` *over* this output, so a vendor that knows better always wins.
 */

/** What this classifier can assert. A narrower type than `Signals`: it never emits the other keys. */
export type EdgeSignals = Partial<
  Record<
    Extract<SignalKey, "recipient_count" | "record_count" | "recipient_external" | "amount">,
    string | number | boolean | null
  >
>;

/** Argument keys read for each fact, when the vendor does not name its own. */
export interface EdgeFields {
  /** Keys holding recipients — an array, or a string that may carry several addresses. */
  recipients?: string[];
  /** Keys holding the records an action touches. Counted by array length. */
  records?: string[];
  /** Keys holding a money amount. Only read when `amountInMinorUnits` is also set. */
  amount?: string[];
}

export interface EdgeClassifierOptions {
  /**
   * Domains that count as inside the boundary, e.g. `["acme.example"]`. Without it
   * `recipient_external` is not emitted at all: "external" is a fact about *your* perimeter, and
   * guessing it would be worse than the `unknown` the reviewer currently sees.
   */
  internalDomains?: string[];
  /**
   * Whether the values in the `amount` fields are already in minor units, as `SIGNAL_KEYS.amount`
   * requires. There is no safe default — `12.50` and `1250` are the same money in different units,
   * and a hundredfold error in either direction moves a call across the bulk threshold and in or out
   * of the money rule. So `amount` is emitted only when this is stated, and a `false` here scales
   * the value by 100 rather than shipping the wrong unit.
   */
  amountInMinorUnits?: boolean;
  /** Override the argument keys read per fact. Replaces the defaults for the facts it names. */
  fields?: EdgeFields;
}

/**
 * The naming conventions. These are argument keys — the vendor's own vocabulary for its own call —
 * not tool names, so reading them stays on the right side of the line above.
 */
const DEFAULT_FIELDS: Required<Omit<EdgeFields, "amount">> & { amount: string[] } = {
  recipients: ["to", "recipient", "recipients", "cc", "bcc", "email", "emails", "phone", "phones"],
  records: ["ids", "records", "items", "rows", "documents", "files"],
  // Only unambiguously monetary names. `value`, `sum` and a bare `total` are deliberately absent:
  // they are ordinary words for ordinary arguments, and `settings.update({ value: 250000 })` would
  // otherwise be declared a six-figure amount — pushing `magnitude` to `bulk` on a call that moves
  // no money at all. A declared signal overrides Heron's derivation, so a wrong one is worse than
  // the `unknown` it replaces. A vendor whose own field is called `total` names it in `fields`.
  amount: ["amount", "amount_minor", "total_amount", "price"],
};

/** Counts the anchors in a string: one field may carry `"a@x.example, b@y.example"`. */
function countAnchors(text: string): number {
  let n = 0;
  for (const { re } of ANCHOR_PATTERNS) {
    // The shared patterns are /g, so `match` (which resets) is used rather than `test` (which does not).
    n += text.match(re)?.length ?? 0;
  }
  return n;
}

/** Every email address in a value, flattened across arrays. */
function emailsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(emailsIn);
  if (typeof value !== "string") return [];
  const email = ANCHOR_PATTERNS.find((p) => p.type === "email");
  return email ? (value.match(email.re) ?? []) : [];
}

/**
 * How many recipients a value carries. An array is counted by length — its entries are recipients
 * whether or not they look like addresses (a user id is still a recipient). A string is counted by
 * the anchors in it, and falls back to 1 for a non-empty value that carries none.
 */
function countRecipients(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "string") return 0;
  const anchors = countAnchors(value);
  if (anchors > 0) return anchors;
  return value.trim().length > 0 ? 1 : 0;
}

function firstNumber(args: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Read a call's arguments and produce the signals they actually support.
 *
 * Emits a key only when the arguments answer it: a fact absent here reaches Heron as `unknown`,
 * which is the honest reading — the vendor did not send it — and never a fabricated default.
 */
export function classifyAtEdge(
  args: Record<string, unknown>,
  options: EdgeClassifierOptions = {},
): EdgeSignals {
  const fields = { ...DEFAULT_FIELDS, ...options.fields };
  const signals: EdgeSignals = {};

  const recipients = fields.recipients.reduce(
    (sum, key) => sum + (key in args ? countRecipients(args[key]) : 0),
    0,
  );
  if (recipients > 0) signals.recipient_count = recipients;

  const records = fields.records.reduce(
    (sum, key) => sum + (Array.isArray(args[key]) ? (args[key] as unknown[]).length : 0),
    0,
  );
  if (records > 0) signals.record_count = records;

  // Only with a perimeter to compare against, and only over addresses we can actually read: a
  // recipient list of opaque user ids says nothing about which side of the boundary they sit on.
  if (options.internalDomains && options.internalDomains.length > 0) {
    const addresses = fields.recipients.flatMap((key) => emailsIn(args[key]));
    if (addresses.length > 0) {
      const internal = options.internalDomains.map((d) => d.toLowerCase().replace(/^@/, ""));
      signals.recipient_external = addresses.some((address) => {
        const domain = address.split("@").pop()?.toLowerCase() ?? "";
        return !internal.some((d) => domain === d || domain.endsWith(`.${d}`));
      });
    }
  }

  if (options.amountInMinorUnits !== undefined) {
    const amount = firstNumber(args, fields.amount ?? DEFAULT_FIELDS.amount);
    if (amount !== null) {
      signals.amount = options.amountInMinorUnits ? amount : Math.round(amount * 100);
    }
  }

  return signals;
}
