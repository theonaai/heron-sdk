import { DIMENSIONS, type DimensionKey } from "./policy/taxonomy";

/**
 * The trust boundary, as data (docs/trust-boundary.md).
 *
 * There is exactly one seam between the vendor and Heron, and everything that crosses it crosses as a
 * *signed statement*, never as raw text. This file is the single place that names what crosses and,
 * for the one part of the seam that actually slides, how far each piece can slide. Move the boundary
 * here or not at all — a signal added in the vendor SDK but absent here is invisible to the
 * classifier, and a key the classifier reads but this file does not list is a compile error.
 *
 * Three statements make the seam, and each is pinned by an invariant, not by taste:
 *
 *   - session / before_action   the vendor states an action; Heron replies with a signed *decision*
 *                               receipt (src/lib/receipts.ts) — the real verdict it enforces.
 *   - execution_evidence        the vendor signs what it actually did (src/lib/receipts.ts,
 *                               `ExecutionEvidencePayload`); Heron verifies the signature and *stores*
 *                               it (invariant #5), the finding is never the rejection.
 *
 * The payload shapes for those statements live in receipts.ts (what Heron signs) and schemas.ts (what
 * Heron accepts) — they are not restated here, because a second copy is a second thing to drift. What
 * *is* here is the movable part: the `signals` vocabulary. A signal is a scalar fact the vendor
 * computes on its edge, where the conversation still exists, and sends already reduced (invariant #6
 * forbids the text itself from crossing). Each one either lets Heron *stop guessing* a dimension it
 * would otherwise derive from the tool name, or supplies a fact Heron cannot derive at all. The
 * `derivable` field records which — and that is the boundary made explicit: `"none"` means the truth
 * is pinned to the vendor's side and no amount of cooperation moves it left; `"full"`/`"partial"`
 * mean Heron has a fallback and the vendor's signal only sharpens it.
 */

/** A scalar signal's JSON type — the schema (src/lib/schemas.ts) enforces the same union on the wire. */
export type SignalType = "string" | "number" | "boolean";

/**
 * How much of the dimension a signal feeds Heron can produce *without* it, from the tool name alone:
 *   - "full"    — Heron derives a usable value; the signal only raises `source` to `declared`.
 *   - "partial" — Heron derives some cases but not all (personal data, an approval on some ops).
 *   - "none"    — Heron cannot derive it; without the signal the dimension stays `unknown`. The fact
 *                 is pinned to the vendor's edge.
 */
export type Derivable = "full" | "partial" | "none";

export interface SignalSpec {
  /**
   * The classification dimension this signal sets (src/lib/policy/classify.ts), or one of the two
   * statements that are not a dimension: the STEP_UP approval, and the provenance of a model's claim.
   */
  readonly feeds: DimensionKey | "approval" | "inference";
  readonly type: SignalType;
  readonly derivable: Derivable;
  /** Why it is what it is — the constraint, for whoever moves the boundary next. */
  readonly note: string;
}

/**
 * The whole signal vocabulary. Adding a row here and reading it in classify.ts is how a fact moves
 * from "Heron guesses it" to "the vendor asserts it" — the one place the trust boundary slides.
 */
export const SIGNAL_KEYS = {
  op: {
    feeds: "operation",
    type: "string",
    derivable: "full",
    note: "read|write|send|delete|execute. Overrides the verb regex on the tool name.",
  },
  data_class: {
    feeds: "data_class",
    type: "string",
    derivable: "partial",
    note: "operational|financial|credential|personal. `personal` is NEVER derived — a name cannot tell you a sheet of numbers is personal data; only the vendor can.",
  },
  destination: {
    feeds: "destination",
    type: "string",
    derivable: "none",
    note: "internal|external|third_party for a send/write. A `gmail:` resource does not name its recipient — undecidable from the tool name.",
  },
  recipient_external: {
    feeds: "destination",
    type: "boolean",
    derivable: "none",
    note: "Shorthand for `destination` when the full class is overkill. Same pinning: not derivable.",
  },
  record_count: {
    feeds: "magnitude",
    type: "number",
    derivable: "none",
    note: "How many records the action touches. Magnitude is invisible from a tool name.",
  },
  recipient_count: {
    feeds: "magnitude",
    type: "number",
    derivable: "none",
    note: "How many recipients a send reaches. Magnitude is invisible from a tool name.",
  },
  amount: {
    feeds: "magnitude",
    type: "number",
    derivable: "none",
    note: "Money moved, in minor units. Magnitude is invisible from a tool name.",
  },
  reversible: {
    feeds: "reversibility",
    type: "boolean",
    derivable: "partial",
    note: "Heron derives a default per operation (a send is terminal, a read reversible); this overrides it for the cases the heuristic gets wrong. Two-valued, so it cannot say `costly` — use `reversibility` where the honest answer is the middle one.",
  },
  reversibility: {
    feeds: "reversibility",
    type: "string",
    derivable: "partial",
    note: "The dimension in full: `reversible` | `costly` | `terminal`. `costly` is the value `reversible` cannot express — recovery exists but is not an undo (a record the agent can regenerate, a file restorable from a backup). Without it, a vendor whose delete is recoverable-at-a-cost must either overclaim `true` or accept `terminal`, and the rule that allows a recoverable delete is unreachable by declaration. Wins over `reversible` when both are sent.",
  },
  resolves_action: {
    feeds: "approval",
    type: "string",
    derivable: "none",
    note: "action_id of the STEP_UP a human answered. Only the vendor knows a person decided — never derivable.",
  },
  human_decision: {
    feeds: "approval",
    type: "string",
    derivable: "none",
    note: "APPROVE lifts the named STEP_UP; anything else is a decline (an approval must be stated, never assumed).",
  },
  approver: {
    feeds: "approval",
    type: "string",
    derivable: "none",
    note: "Opaque token for who approved — never a name (invariant #6). Enough to tell two approvers apart. Goes with `resolves_action` or with `human_authorized`.",
  },
  human_authorized: {
    feeds: "approval",
    type: "boolean",
    derivable: "none",
    note: "A human cleared this call in the vendor's own UI BEFORE Heron saw it, so it answers no STEP_UP of ours. Recorded and published; it never lifts a verdict, because unlike `resolves_action` there is no action of ours it can be checked against.",
  },
  inferred: {
    feeds: "inference",
    type: "string",
    derivable: "none",
    note: "Comma-separated dimension names whose value on THIS call came from a model rather than from a measurement (`formatInferredDimensions`). It does not carry a value of its own — it re-labels the signals sent beside it, so their `source` is published as `inferred` instead of `declared`. Only the vendor knows which of its own claims are testimony; nothing on our side can tell them apart, which is exactly why the fold would be permanent.",
  },
  inference_model: {
    feeds: "inference",
    type: "string",
    derivable: "none",
    note: "The model that answered, as the vendor names it. Required whenever `inferred` is sent — an unattributed model claim is one a reviewer can count and not question.",
  },
  inference_prompt_hash: {
    feeds: "inference",
    type: "string",
    derivable: "none",
    note: "Hash of the judging prompt the SDK put to the model — the question came from us, versioned and signed, never from the text under attack. Required whenever `inferred` is sent.",
  },
  inference_slice: {
    feeds: "inference",
    type: "string",
    derivable: "none",
    note: "A label for how much of the conversation the fork saw (`last_turn`, `turn_and_plan`) — never any of it. Required whenever `inferred` is sent.",
  },
} as const satisfies Record<string, SignalSpec>;

/**
 * The encoding of `inferred`, owned here because both sides read it: the vendor SDK writes it, the
 * classifier reads it, and the reviewer's browser re-reads it out of the published signals to
 * reproduce our verdict. A second copy of the split rule is a second thing to drift, and it would
 * drift silently — a mis-parsed name simply leaves the dimension `declared`, which is the one
 * outcome this whole distinction exists to prevent.
 *
 * It names *dimensions*, not signal keys, and that choice is the guard: the approval keys feed no
 * dimension, so there is no spelling of `inferred` that marks `human_decision` as a model's word. A
 * model able to sign off on its own step-up would be a one-key bypass of every human gate, available
 * to anyone who can prompt one.
 *
 * Unknown names are dropped rather than rejected: the parser runs in a reviewer's browser against
 * bytes that were signed under an older taxonomy, where refusing the whole list would turn a
 * dimension we since renamed into an unverifiable receipt. The wire schema is where a name that is
 * not a dimension is refused, at the door, before anything is signed.
 */
export function parseInferredDimensions(value: string): DimensionKey[] {
  const names = value.split(",").map((name) => name.trim());
  return DIMENSIONS.filter((d) => names.includes(d));
}

/** The inverse — the only place the separator is written. */
export function formatInferredDimensions(dimensions: readonly DimensionKey[]): string {
  return DIMENSIONS.filter((d) => dimensions.includes(d)).join(",");
}

/** The wire key of a signal — the classifier's helpers are typed to this, so a typo will not compile. */
export type SignalKey = keyof typeof SIGNAL_KEYS;

/** The vocabulary as a list, for anyone iterating the contract (the drift guard, generated docs). */
export const SIGNAL_KEY_LIST = Object.keys(SIGNAL_KEYS) as SignalKey[];
