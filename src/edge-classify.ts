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

/**
 * What the guard knows about the call being classified, for a perimeter that is not global.
 *
 * Everything here is already on the vendor's side of the boundary and none of it crosses because of
 * this type: it exists so `internalDomains` can be answered per call rather than per process.
 */
export interface EdgeContext {
  tool: string;
  provider?: string;
  server?: string;
  /** The principal the guard was opened for — opaque, as invariant #6 requires. */
  principal?: { type: string; ref: string };
  sessionExternalId?: string;
}

export interface EdgeClassifierOptions {
  /**
   * Domains that count as inside the boundary, e.g. `["acme.example"]`. Without it
   * `recipient_external` is not emitted at all: "external" is a fact about *your* perimeter, and
   * guessing it would be worse than the `unknown` the reviewer currently sees.
   *
   * **A function, when "inside" is not a property of your process.** On a multi-tenant platform the
   * perimeter belongs to the *customer* whose agent is running, not to the vendor: one global list
   * declares the vendor's own staff internal to somebody else's agent, and because
   * `classifyDestination` records the signal as `declared`, that wrong `internal` is a signed
   * falsehood which also drops the call out of the external-send rule that would otherwise have
   * caught even `unknown`. This was the reason the first integration left the whole classifier off,
   * so it cost far more than the one dimension it belongs to.
   *
   * Return `undefined` (or an empty array) for a call whose tenant you cannot resolve, and nothing
   * is claimed — the same honest `unknown` as having no perimeter at all.
   */
  internalDomains?: string[] | ((context: EdgeContext) => string[] | undefined);
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

/**
 * How deep to look for the conventional keys, and how much of a call to walk doing it.
 *
 * Reading only the top level was measured, not assumed: over a 30-day production window the guard
 * emitted a signal on **0.8%** of calls, because a platform's arguments are nested — a tool bus
 * wraps them (`{ params: { … } }`), a message carries its own envelope (`{ message: { to: … } }`),
 * and a batch is a list of objects each with a recipient. The keys were there; nothing looked at
 * them.
 *
 * The depth is bounded because this runs on the path of every tool call, and the node budget bounds
 * the pathological case a depth limit alone does not — a wide object at depth 1. Both are limits on
 * *our* work, never on what is claimed: reaching either stops the walk, and an unfound key is simply
 * not emitted, which is the same honest `unknown` as before.
 */
const MAX_DEPTH = 4;
const MAX_NODES = 1000;

/**
 * Every value stored under one of `keys`, anywhere within the depth limit.
 *
 * Descends through plain objects and through the objects inside arrays — a batch of messages is the
 * ordinary shape for the very facts this classifier exists to count — but never treats an array
 * *found at a key* as something to descend into for that same key: `{ to: ["a", "b"] }` is two
 * recipients, counted by the caller, not a container to search for more `to`s.
 */
function valuesAt(root: unknown, keys: string[]): unknown[] {
  const found: unknown[] = [];
  let budget = MAX_NODES;

  const walk = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_DEPTH || node === null || typeof node !== "object") return;
    budget -= 1;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (keys.includes(key)) {
        found.push(value);
        // Not descended into: the value *is* the answer for this key. Descending would count a
        // recipient list twice — once as a list, once as its items.
        continue;
      }
      walk(value, depth + 1);
    }
  };

  walk(root, 0);
  return found;
}

function firstNumber(args: Record<string, unknown>, keys: string[]): number | null {
  for (const value of valuesAt(args, keys)) {
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
  context: EdgeContext = { tool: "" },
): EdgeSignals {
  const fields = { ...DEFAULT_FIELDS, ...options.fields };
  const signals: EdgeSignals = {};
  const recipientValues = valuesAt(args, fields.recipients);

  const recipients = recipientValues.reduce<number>((sum, value) => sum + countRecipients(value), 0);
  if (recipients > 0) signals.recipient_count = recipients;

  const records = valuesAt(args, fields.records).reduce<number>(
    (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
    0,
  );
  if (records > 0) signals.record_count = records;

  // Only with a perimeter to compare against, and only over addresses we can actually read: a
  // recipient list of opaque user ids says nothing about which side of the boundary they sit on.
  const perimeter =
    typeof options.internalDomains === "function"
      ? options.internalDomains(context)
      : options.internalDomains;
  if (perimeter && perimeter.length > 0) {
    const addresses = recipientValues.flatMap(emailsIn);
    if (addresses.length > 0) {
      const internal = perimeter.map((d) => d.toLowerCase().replace(/^@/, ""));
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
