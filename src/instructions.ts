import { hashCanonical } from "./crypto/hash";

/**
 * The commitment to the agent's own governing text.
 *
 * Everything else the vendor sends is about a *call*: the arguments per action, the request once at
 * session open. The model's context is outside every byte of it — and a runtime may rewrite the
 * system prompt and the plan block mid-session, which is ordinary rather than exotic (a working plan
 * lives there, and compaction rewrites the transcript on most turns). So an agent that read an
 * external page and then rewrote its own instructions leaves exactly the trace of one that carried
 * on, and no reader of the evidence can tell.
 *
 * Sending `instructions_hash` on an action closes that. Heron publishes *that the instructions
 * changed between two commitments* — never a byte of what they say — and the digests sit beside
 * every action, so the change count is the reviewer's arithmetic rather than anyone's claim.
 *
 * Three things about it are deliberate, and each has a matching refusal on Heron's side:
 *
 *   - **It is not in `SIGNAL_KEYS`.** The classifier's vocabulary is what a rule can turn on, and
 *     this must never be: a commitment whose value could move a verdict would be a new way for the
 *     audited party to steer one, and the entire worth of this scalar is that it is inert.
 *   - **Silence is never stability.** An action carrying no commitment is published as
 *     *uncommitted*, not as *unchanged* — a runtime that stops committing exactly when its agent
 *     rewrites its own plan must not read like one whose text held still. Commit on every action or
 *     accept that the coverage figure says you did not.
 *   - **A malformed digest is refused with a 400.** It would compare unequal to everything including
 *     a later copy of itself, and so publish "the instructions changed" on every action carrying it
 *     — a false finding about your own agent, sealed into a record nobody can correct. Which is why
 *     the helper below exists: the shape is `sha256:<64 hex>`, and there is no reason to hand-roll it.
 *
 * The limit, stated where it is written rather than in a footnote: this is testimony. You compute
 * the digest over text Heron never sees, so it catches *inconsistency*, never fabrication — and it
 * says *that* the instructions changed, never *what* changed.
 */

/** The key it travels under, in `signals` beside the ordinary vocabulary. */
export const INSTRUCTIONS_SIGNAL = "instructions_hash";

/**
 * Digest the instruction slot: the system prompt, plus whatever plan block governs the run.
 *
 * Over the canonical form of the two fields rather than their concatenation, so a system prompt
 * ending where a plan begins cannot collide with the same bytes split differently — a change that
 * moved text from one slot to the other would otherwise hash identically and publish as *unchanged*.
 * `plan` defaults to `null` rather than `""`, so "no plan block" and "an empty plan block" are two
 * commitments, which is what they are.
 *
 * Hash the *slot*, not the whole context: a digest over the transcript changes on every turn and is
 * a constant in the only sense that matters — it would report a change on every action and locate
 * nothing.
 */
export function instructionsHash(input: { system: string; plan?: string | null }): string {
  return hashCanonical({ system: input.system, plan: input.plan ?? null });
}
