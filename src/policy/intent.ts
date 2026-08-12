import { SIGNAL_KEYS, type SignalKey, formatInferredDimensions } from "../contract";
import {
  INTENT_DIMENSIONS,
  INTENT_PROMPT,
  INTENT_PROMPT_HASH,
  INTENT_PROMPT_VERSION,
  INTENT_TAXONOMY,
  INTENT_TAXONOMY_DOCUMENTATION,
  isIntentTaxonomyValue,
  type IntentDimension,
} from "./intent-taxonomy";

export {
  INTENT_DIMENSIONS,
  INTENT_PROMPT,
  INTENT_PROMPT_HASH,
  INTENT_PROMPT_VERSION,
  INTENT_TAXONOMY,
  INTENT_TAXONOMY_DOCUMENTATION,
};
export type { IntentDimension };

/**
 * The fork — the vendor asks its own model what it is about to do, and the answer crosses as a
 * marked claim rather than as a measurement.
 *
 * The signal has to be computed where the conversation lives, and the cheapest judge with the full
 * context is the agent itself: before a group of tool calls the vendor's runtime forks the live
 * session — same agent, same model — and puts the question below to it. The prefix is already
 * cached, so the marginal cost is a completion rather than a conversation.
 *
 * **Nothing here believes the answer, and that is the design rather than a caveat.** A judge that
 * shares the attacker's channel cannot be trusted by construction, so four properties carry this
 * file, and each is the answer to a way the mechanism could have been turned around:
 *
 *   - **The question is ours, versioned, and its hash is published.** `INTENT_PROMPT` is a constant
 *     in this package, not a string assembled from the agent's system prompt — the text under
 *     attack does not get to write the question put to the witness. `INTENT_PROMPT_HASH` travels on
 *     every claim, so a reviewer can see *what was asked* by looking up one published constant.
 *   - **It may only resolve an ignorance.** Heron consults an `inferred` value strictly where its
 *     own pass came back `unknown`, and `stripMeasured()` below removes a claimed dimension that
 *     anything on this side already measured — before it is sent, so the measurement is never
 *     replaced in transit by the testimony that was supposed to sit under it.
 *   - **It cannot reach a human gate.** The marking names *dimensions*, and the approval keys feed
 *     no dimension, so there is no answer a model can give that signs off on its own step-up.
 *   - **Silence is the failure mode.** A malformed answer, an unsupported value, a fork that threw
 *     or a model that declined all produce *no claim*, never a guess. A missing claim leaves the
 *     dimension `unknown`, which is the strict direction: the friction stays, and only a
 *     well-formed answer can buy it back.
 *
 * Pure, and free of any transport: the SDK owns the question, the vocabulary and the parsing, and
 * the *asking* is the vendor's — it is their session to fork, their model, their bill.
 */

/**
 * How much of the conversation the fork was shown. A label, never the text (invariant #6).
 *
 * Left open as a string on the wire so a vendor whose runtime slices differently can say so, but the
 * two shapes we have designed for are named here: the last model turn alone, or that turn plus the
 * plan block that governs it.
 */
export type IntentSlice = "last_turn" | "turn_and_plan" | (string & {});

/**
 * Which signal key carries each answered dimension.
 *
 * The claim rides in the ordinary vocabulary — there is no separate wire form for a model's value —
 * and `inferred` is what re-labels its `source`. That is the whole reason the marking exists, and it
 * is also why a claim must never be merged over a measurement: on the wire the two are the same key.
 */
const DIMENSION_SIGNAL: Record<IntentDimension, SignalKey> = {
  operation: "op",
  data_class: "data_class",
  destination: "destination",
  reversibility: "reversibility",
};

/** One call, as the fork is told about it. The name only — never the arguments. */
export interface IntentCall {
  /** How the answer refers back to this call. Unique within the turn. */
  ref: string;
  /** The tool as the vendor's runtime names it. */
  name: string;
}

/** What to put to the forked session. */
export interface IntentQuestion {
  /** The full text to send: the judging instructions, then the calls. */
  prompt: string;
  /**
   * Hash of the **instructions alone**, not of this turn's text.
   *
   * A hash covering the call list would be unique per turn and a reviewer could look it up against
   * nothing. What the field is for is *"the question came from the SDK, at this version"* — one
   * published constant, recomputable from this package by anyone holding a receipt.
   */
  promptHash: string;
  /** The calls, in the order they appear in `prompt`. */
  calls: readonly IntentCall[];
}

/** What the fork said about one call, after parsing. Only dimensions it actually answered. */
export interface IntentClaim {
  ref: string;
  dimensions: Partial<Record<IntentDimension, string>>;
}

/**
 * Fork the live session and put the question to it. Returns the model's raw reply, or `null` to
 * decline this turn.
 *
 * Deliberately the vendor's to implement: the session to fork is theirs, the model is theirs, the
 * tokens are on their bill, and this package holds no transport. Returning `null` (or throwing — the
 * guard catches it) costs the turn its claim and nothing else.
 */
export type IntentAsker = (question: IntentQuestion) => Promise<string | null>;

export interface IntentOptions {
  ask: IntentAsker;
  /** The model that answered, as you name it — published beside every dimension it supplied. */
  model: string;
  /** How much of the conversation the fork saw. A label, never the text. */
  slice: IntentSlice;
}

/** The signals a claim becomes: the answered dimensions, the marking, and the witness. */
export type IntentSignals = Partial<Record<SignalKey, string>>;

/** Compose the question for one model turn's calls. */
export function buildIntentQuestion(calls: readonly IntentCall[]): IntentQuestion {
  const list = calls.map((c) => `- ref: ${c.ref} — tool: ${c.name}`).join("\n");
  return {
    prompt: `${INTENT_PROMPT}\nCalls:\n\n${list}\n`,
    promptHash: INTENT_PROMPT_HASH,
    calls,
  };
}

/**
 * Turn a model's raw reply into claims, accepting only a complete v2 answer.
 *
 * Strict about the answer contract, forgiving only about legacy wrapping and ref selection. A
 * fenced code block or a bare array remains accepted for API compatibility. Every row must contain
 * exactly the v2 fields and values, and duplicate refs reject the whole answer. Valid rows outside
 * `refs` remain ignored: integrations may ask the fork once for a whole turn, then parse that same
 * answer once per call. Partial recovery within a row would let an invalid account silently become
 * a different valid account before it is sealed into an immutable classification.
 *
 * `refs` selects the calls the caller is parsing. Every selected ref must be present exactly once.
 */
export function parseIntentAnswer(raw: string | null, refs: readonly string[]): IntentClaim[] {
  if (!raw) return [];
  const text = stripFence(raw).trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && hasExactKeys(parsed, ["calls"]) && Array.isArray(parsed.calls)
      ? parsed.calls
      : null;
  if (!rows) return [];

  const wanted = new Set(refs);
  if (wanted.size !== refs.length) return [];

  const seen = new Set<string>();
  const selected = new Set<string>();
  const claims: IntentClaim[] = [];
  const answerFields = ["ref", ...INTENT_DIMENSIONS];

  for (const row of rows) {
    if (!isRecord(row) || !hasExactKeys(row, answerFields)) return [];
    const ref = typeof row.ref === "string" ? row.ref : null;
    if (!ref || seen.has(ref)) return [];
    seen.add(ref);

    const dimensions: Partial<Record<IntentDimension, string>> = {};
    for (const dimension of INTENT_DIMENSIONS) {
      const value = row[dimension];
      if (typeof value !== "string" || !isIntentTaxonomyValue(dimension, value)) return [];
      if (value !== "unknown") dimensions[dimension] = value;
    }

    if (!wanted.has(ref)) continue;
    selected.add(ref);
    if (Object.keys(dimensions).length > 0) claims.push({ ref, dimensions });
  }

  return selected.size === wanted.size ? claims : [];
}

/**
 * A claim, as signals — the answered dimensions under their ordinary keys, plus the four-part
 * statement that says a model produced them.
 *
 * Returns `{}` for a claim with nothing left in it. Heron refuses a witness that marks no dimension
 * (and a marking with no witness) at the door, in both directions, so an empty claim must produce no
 * keys at all rather than provenance for a non-answer.
 */
export function intentSignals(
  claim: Pick<IntentClaim, "dimensions">,
  opts: Pick<IntentOptions, "model" | "slice">,
): IntentSignals {
  const dimensions = Object.keys(claim.dimensions) as IntentDimension[];
  if (dimensions.length === 0) return {};

  const signals: IntentSignals = {};
  for (const dimension of dimensions) {
    signals[DIMENSION_SIGNAL[dimension]] = claim.dimensions[dimension];
  }
  return {
    ...signals,
    inferred: formatInferredDimensions(dimensions),
    inference_model: opts.model,
    inference_prompt_hash: INTENT_PROMPT_HASH,
    inference_slice: opts.slice,
  };
}

/**
 * Drop every claimed dimension that something on this side already measured, and re-derive the
 * marking from what is left.
 *
 * This is where *"a model may resolve an unknown, never contradict a stated fact"* is enforced on the
 * sending side, and it is not a duplicate of Heron's rule — it closes a hole that only exists here.
 * A claim travels under the same signal key as a measurement (`destination`, `op`, …), so merging a
 * claim over a contract's own value would not merely lose the argument: it would *replace* the
 * measurement in transit and mark the survivor as a model's word. Heron would then see one value,
 * labelled `inferred`, and never learn that the vendor's own edge had measured something else.
 *
 * The check is per *dimension*, not per key, because several keys feed one: a contract that sent
 * `recipient_external` has stated the destination, and a claim about `destination` must yield to it
 * just as surely as to the key of the same name.
 *
 * What survives is a claim about dimensions nobody on this side could answer — which is the only
 * kind worth sending, and the only kind Heron will read.
 */
export function stripMeasured(
  claim: IntentSignals,
  measured: Readonly<Record<string, unknown>>,
): IntentSignals {
  const spoken = new Set<string>();
  for (const key of Object.keys(measured)) {
    if (measured[key] === undefined) continue;
    const feeds = SIGNAL_KEYS[key as SignalKey]?.feeds;
    if (feeds) spoken.add(feeds);
  }

  const kept: Partial<Record<IntentDimension, string>> = {};
  for (const dimension of INTENT_DIMENSIONS) {
    if (spoken.has(dimension)) continue;
    const value = claim[DIMENSION_SIGNAL[dimension]];
    if (typeof value === "string") kept[dimension] = value;
  }

  const model = claim.inference_model;
  const slice = claim.inference_slice;
  if (!model || !slice) return {};
  return intentSignals({ dimensions: kept }, { model, slice });
}

/** ```json … ``` and its unlabelled cousin, which models emit whatever the instruction says. */
function stripFence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced?.[1] ?? raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}
