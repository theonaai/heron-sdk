import { SIGNAL_KEYS, type SignalKey, formatInferredDimensions } from "../contract";
import { sha256Tagged } from "../crypto/hash";
import type {
  DataClass,
  Destination,
  DimensionKey,
  Operation,
  Reversibility,
} from "./taxonomy";

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
 *   - **Silence is the failure mode.** A malformed answer, an unknown value, a fork that threw or a
 *     model that declined all produce *no claim*, never a guess. A missing claim leaves the
 *     dimension `unknown`, which is the strict direction: the friction stays, and only a
 *     well-formed answer can buy it back.
 *
 * Pure, and free of any transport: the SDK owns the question, the vocabulary and the parsing, and
 * the *asking* is the vendor's — it is their session to fork, their model, their bill.
 */

/**
 * Bumped whenever `INTENT_PROMPT` changes by a byte.
 *
 * The hash is what a reviewer actually checks, so this is for humans reading a changelog. Both move
 * together and neither is derived from the other: a version with no hash change would be a lie about
 * the bytes, and a hash change with no version bump is a question nobody can name.
 */
export const INTENT_PROMPT_VERSION = 1;

/**
 * The judging instructions, verbatim — the bytes `INTENT_PROMPT_HASH` covers.
 *
 * Written to be answerable by a model that is *about to act* rather than one reviewing a transcript,
 * and to make the honest answer the cheap one. Three things in it are load-bearing:
 *
 *   - **`unknown` is offered on every dimension, and is stated to be the right answer when unsure.**
 *     A claim only ever fills a dimension nothing else determined, so an uncertain guess buys back
 *     friction that ignorance had correctly created — the one thing an injected judge is able to do.
 *     Making `unknown` cheap is what keeps that narrow.
 *   - **It asks about the call, never about the conversation.** No summary, no quotation, no
 *     recipient names: what comes back is five closed vocabularies, so invariant #6 holds by the
 *     shape of the answer rather than by a redaction step afterwards.
 *   - **It does not ask whether the call is *allowed*.** The verdict is Heron's and rests on
 *     published rules; a model asked to approve its own action would be answering the question this
 *     whole product exists to take away from it.
 */
export const INTENT_PROMPT = `You are a fork of the agent session that is about to make the tool calls listed below. Classify each call. This is not a request for permission and your answer does not decide whether a call runs — an independent policy engine decides that, and your answer is recorded beside its decision as testimony.

For each call, answer with these fields:

- operation: read | write | send | delete | execute | unknown
- data_class: none | operational | financial | credential | personal | unknown
- destination: none | internal | external | third_party | unknown
- reversibility: reversible | costly | terminal | unknown

Rules:

1. Answer "unknown" whenever you are not sure. An unsure answer is worse than no answer: a wrong one removes a safeguard that your uncertainty had correctly put in place.
2. Answer only about the calls listed. Do not describe the conversation, quote it, name any person, or include any content from it.
3. Reply with JSON and nothing else, in this shape:

{"calls":[{"ref":"<the ref given below>","operation":"...","data_class":"...","destination":"...","reversibility":"..."}]}
`;

/** Hash of the judging instructions — see `IntentQuestion.promptHash` for what it does and does not cover. */
export const INTENT_PROMPT_HASH = sha256Tagged(INTENT_PROMPT);

/**
 * How much of the conversation the fork was shown. A label, never the text (invariant #6).
 *
 * Left open as a string on the wire so a vendor whose runtime slices differently can say so, but the
 * two shapes we have designed for are named here: the last model turn alone, or that turn plus the
 * plan block that governs it.
 */
export type IntentSlice = "last_turn" | "turn_and_plan" | (string & {});

/** The four dimensions a model is asked about, and why the fifth is missing.
 *
 * `magnitude` is deliberately absent. Its signals are counts — `record_count`, `recipient_count`,
 * `amount` — and a count is a measurement, available to `classifyAtEdge()` from the arguments. Asking
 * a model to produce one would dress an estimate as an observation in the one dimension where the
 * difference is a number a reviewer will read as exact. */
export const INTENT_DIMENSIONS = [
  "operation",
  "data_class",
  "destination",
  "reversibility",
] as const;

export type IntentDimension = (typeof INTENT_DIMENSIONS)[number];

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

/**
 * The accepted answers, per dimension.
 *
 * Typed against the taxonomy unions, so a value this file accepts but Heron does not classify is a
 * compile error here rather than a signal silently ignored on the far side. `unknown` is absent from
 * every list on purpose: it is the model declining, and a declined dimension produces no claim at
 * all — sending `"unknown"` as a value would mark a dimension as a model's word and then say nothing
 * with it, which is provenance for a non-answer.
 */
const ACCEPTED: {
  operation: readonly Exclude<Operation, "unknown">[];
  data_class: readonly Exclude<DataClass, "unknown">[];
  destination: readonly Exclude<Destination, "unknown">[];
  reversibility: readonly Exclude<Reversibility, "unknown">[];
} = {
  operation: ["read", "write", "send", "delete", "execute"],
  data_class: ["none", "operational", "financial", "credential", "personal"],
  destination: ["none", "internal", "external", "third_party"],
  reversibility: ["reversible", "costly", "terminal"],
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
 * Turn a model's raw reply into claims, keeping only what is unambiguous.
 *
 * Strict about values, forgiving about wrapping — the asymmetry is the point. A fenced code block or
 * a bare array is a well-known habit of every current model and costs nothing to accept; a value
 * outside the closed vocabulary is a claim nobody can act on, and admitting it would seal a garbage
 * dimension into an immutable classification. A reply this cannot read produces no claims at all,
 * which leaves every dimension `unknown` — the strict direction.
 *
 * `refs` is what was asked about: an answer naming a call that was not in the question is dropped,
 * because a claim is attributable to a call or it is nothing.
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
    : isRecord(parsed) && Array.isArray(parsed.calls)
      ? parsed.calls
      : null;
  if (!rows) return [];

  const wanted = new Set(refs);
  const seen = new Set<string>();
  const claims: IntentClaim[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const ref = typeof row.ref === "string" ? row.ref : null;
    // A second answer for the same call is dropped rather than merged: two accounts of one call are
    // a model that contradicted itself, and picking one of them is us deciding which it meant.
    if (!ref || !wanted.has(ref) || seen.has(ref)) continue;
    seen.add(ref);

    const dimensions: Partial<Record<IntentDimension, string>> = {};
    for (const dimension of INTENT_DIMENSIONS) {
      const value = row[dimension];
      if (typeof value !== "string") continue;
      const accepted: readonly string[] = ACCEPTED[dimension];
      if (accepted.includes(value)) dimensions[dimension] = value;
    }

    if (Object.keys(dimensions).length > 0) claims.push({ ref, dimensions });
  }

  return claims;
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
