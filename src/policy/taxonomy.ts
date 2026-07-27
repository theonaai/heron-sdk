/**
 * The classification cascade a rule is written against (docs/policy-model.md §3).
 *
 * Five dimensions, each a closed union with a total fallback (`unknown`, or `none` where `none`
 * is the truthful total). Two engineering properties, both load-bearing:
 *
 *   - Mutually exclusive: each dimension is one pure function returning exactly one member. There
 *     is no "set of matching classes" to disambiguate — exclusivity is a type-level fact, not a
 *     tiebreak. `deny-overrides` (src/lib/policy/evaluate.ts) never has to resolve a taxonomy that
 *     cannot say what happened.
 *   - Collectively exhaustive: every function's last branch is a total fallback, so every action —
 *     including a tool shipped tomorrow — lands in a class of every dimension. An unclassifiable
 *     action is never silently allowed; it drives the match to low confidence, and the verdict to
 *     STEP_UP or the bundle's implicit base.
 *
 * `confidence` from Ilya's cascade is NOT a sixth dimension of the action. It is a property of a
 * rule *match*: the weakest `source` among the dimensions that rule actually reads. That is what
 * keeps the engine usable — otherwise, since almost every call is `magnitude: unknown` today, every
 * verdict would be STEP_UP.
 *
 * This file has no imports and runs in the reviewer's browser unchanged.
 */

export type Verdict = "ALLOW" | "DENY" | "MODIFY" | "STEP_UP" | "DEFER";

/**
 * The verdicts the implicit base may be (docs/policy-model.md §1). The base is not a rule — it is what
 * an action falls to when nothing matches — and it is only ever a *withholding* one: DENY (the shipped
 * default) or STEP_UP. It is NOT `Exclude<Verdict, "ALLOW">`, because `MODIFY` and `DEFER` are answers
 * a *rule* produces about a *matched* action (a transform to apply, a context to wait for); neither is
 * a meaningful "nothing matched" outcome, and letting the base be one would be a category error.
 */
export type BaseVerdict = "DENY" | "STEP_UP";

export type Operation = "read" | "write" | "send" | "delete" | "execute" | "unknown";
export type DataClass = "none" | "operational" | "financial" | "credential" | "personal" | "unknown";
export type Destination = "none" | "internal" | "external" | "third_party" | "unknown";
export type Magnitude = "none" | "single" | "bulk" | "unknown";
export type Reversibility = "reversible" | "costly" | "terminal" | "unknown";

export type Confidence = "high" | "medium" | "low";

/**
 * Where a dimension's value came from. This is what a rule's confidence is computed from, and it
 * is published in the classification so a reviewer can size the gap: N verdicts rested on a tool
 * name, M on a signal the vendor computed.
 *
 *   - "declared"   — the vendor sent a signal on *this call* that set it directly.
 *   - "catalogued" — the vendor's signed tool catalogue says this is what the *tool* does.
 *   - "derived"    — we inferred it from the tool name / the operation (our guess).
 *   - "unknown"    — we could not determine it at all.
 *
 * `catalogued` is its own value rather than either neighbour, and collapsing it into one of them
 * would hide the distinction this field exists to publish. It is signed, so `derived` — which reads
 * as "Heron guessed from a string the audited party chose" — understates it. But it describes a
 * tool, not this call: a catalogue entry cannot know that *this* invocation sent to an external
 * recipient, so `declared` overstates it.
 */
export type Source = "declared" | "catalogued" | "derived" | "unknown";

export interface Dimension<T> {
  value: T;
  source: Source;
}

/**
 * A human's answer to a prior STEP_UP, carried on a *new* action that resolves it.
 *
 * This is not a sixth cascade dimension — it does not describe *what the action is*, it records
 * that a person already decided a step-up this action answers. It is the vendor's signed claim (it
 * arrives in `signals`, chain-covered via `signals_hash`), surfaced here so the reviewer recomputes
 * the lift from the published classification, never from a hidden signal. `evaluate()` lets it move
 * a verdict toward the safe side only: an approval turns STEP_UP into ALLOW, a decline forces DENY,
 * and neither can ever lift a rule's DENY (deny-overrides is resolved first).
 */
export interface Approval {
  /**
   * action_id of the STEP_UP this answers — the pair the reviewer follows.
   *
   * `null` when the vendor's own UI cleared the call before Heron ever saw it (`prior`), which
   * answers no step-up of ours and so names no action.
   */
  resolves: string | null;
  /** the human decision: true = approved, false = declined. */
  approved: boolean;
  /** opaque pseudonym of who decided — enough to tell two approvers apart, never who they are. */
  approver: string | null;
  /**
   * The approval happened on the vendor's side, before Heron was asked.
   *
   * It is published because it answers the first question a reviewer asks of an executed action —
   * was a person involved, or did the agent do this by itself — and that fact is otherwise lost
   * entirely. It does **not** move the verdict, and the asymmetry with `resolves` is the whole
   * reason it is a separate field: an approval naming one of our step-ups can be checked against an
   * action we issued, while this one is an unverifiable claim. Letting it lift a STEP_UP would hand
   * every vendor a one-key bypass of every human gate we have.
   */
  prior?: boolean;
}

export interface Classification {
  operation: Dimension<Operation>;
  data_class: Dimension<DataClass>;
  destination: Dimension<Destination>;
  magnitude: Dimension<Magnitude>;
  reversibility: Dimension<Reversibility>;
  /** Present only on an action that resolves a prior STEP_UP; absent on an ordinary call. */
  approval?: Approval;
}

/** The dimensions of a classification, in cascade order. Used to iterate without listing keys twice. */
export const DIMENSIONS = [
  "operation",
  "data_class",
  "destination",
  "magnitude",
  "reversibility",
] as const;

export type DimensionKey = (typeof DIMENSIONS)[number];

/**
 * Ranks a source so a rule can require a minimum: declared > catalogued > derived > unknown.
 *
 * The numbers are ordinals for comparison only — they are never stored, published or hashed, which
 * is what makes inserting a value in the middle safe: no sealed classification carries a rank, so
 * renumbering `declared` cannot change how an old bundle reproduces.
 */
export function sourceRank(source: Source): number {
  if (source === "declared") return 3;
  if (source === "catalogued") return 2;
  if (source === "derived") return 1;
  return 0;
}
