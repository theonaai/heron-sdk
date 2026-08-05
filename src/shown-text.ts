import { hashCanonical } from "./crypto/hash";

/**
 * The commitment to what the human was actually shown.
 *
 * A person approving is already the strongest thing in the record: a *new* action naming the step-up
 * it answers, signed and chained, with the decision stated rather than assumed. What none of it says
 * is what that person was looking at when they said yes — and the two ends of that range leave the
 * identical trace. "Send this contract to 240 recipients outside your company?" and "the agent would
 * like to continue — OK?" produce the same signals, the same classification, the same receipt. So a
 * decision and a rubber stamp are indistinguishable in the one place a reviewer goes looking for a
 * human.
 *
 * Sending `shown_text_hash` on the resolving action closes that, and it closes it in the only way
 * available to us: not by letting anyone read the prompt, but by fixing it. The digest rides in
 * `signals`, so `signals_hash` is in the chained record and **you cannot restate afterwards what you
 * put in front of them** — produce the text later and it either recomputes to what you committed to
 * at the time or it does not.
 *
 * Three things about it are deliberate, and each has a matching behaviour on Heron's side:
 *
 *   - **It is not in `SIGNAL_KEYS`.** Nothing may turn a verdict on it. A rule that fired on this
 *     would make *omitting* it the cheapest way out, and the vendor with the worst confirmation
 *     prompts would be the one with the strongest reason to send nothing.
 *   - **A malformed digest is refused with a 400.** Unlike the instruction commitment, this one is
 *     never compared with anything of Heron's — its whole job is to be reproducible *later*, from
 *     bytes you still hold. So a value nobody can reproduce binds you to nothing while still counting
 *     as an approval bound to its prompt, in a record that cannot be corrected afterwards.
 *   - **Heron publishes only *that* you committed, never the digest.** The instruction commitment is
 *     published per action; this one is not, and the difference is the subject. An instruction slot
 *     is your own prose, so confirming a candidate copy of it tells a holder something about *you*.
 *     A confirmation prompt names a recipient, an amount, a record — so an unkeyed digest of it on a
 *     page a reviewer can read is a confirmation oracle for anyone already holding a candidate
 *     address. Which is the reason for the key below.
 *
 * The limit, stated where it is written rather than in a footnote: this is testimony, and it is
 * testimony about a prompt Heron never sees. It says you are answerable for what you showed. It does
 * not say that what you showed described the call — that judgement needs the text, and the text
 * staying on your side is the whole shape of this integration.
 */

/** The key it travels under, in `signals` beside the ordinary vocabulary. */
export const SHOWN_TEXT_SIGNAL = "shown_text_hash";

/**
 * Digest what your confirmation UI rendered, under your own key.
 *
 * **Why a key at all.** `signals_hash` is published on the evidence page and the rest of the signal
 * vocabulary is small and enumerable, so a plain digest of a prompt is testable by anyone who can
 * guess the prompt — and confirmation prompts are guessable: they are templates with a name and an
 * amount dropped in. A key that never leaves your side removes that, and costs the commitment
 * nothing: you still hold the text, you still hold the key, so you can still put both in front of an
 * auditor and have them recompute. Use the same secret you already pass as `pseudonymSecret` — it is
 * already load-bearing and already retained, so this adds no new way for the proof to evaporate.
 *
 * **Why not HMAC**, which is the reflex and is the wrong instrument here. Every `sha256:` value in
 * this record is a plain SHA-256 over canonical bytes, and the prefix is a promise about how to
 * recompute it, not decoration — an HMAC under it would be a false statement to the one party this
 * exists to convince. What is needed of the construction is *hiding* (a guesser without the key
 * learns nothing) and *binding* (you cannot produce other text that matches), both of which a hash
 * over a canonical pre-image containing the key gives. Authentication under a key the verifier does
 * not hold is not part of the problem: by the time anyone checks this, you have handed them both
 * fields.
 *
 * So the pre-image is an object rather than a concatenation, for the reason `instructionsHash` uses
 * one: `{key: "ab", text: "cd"}` and `{key: "a", text: "bcd"}` must not collide.
 */
export function shownTextHash(input: { text: string; key: string }): string {
  return hashCanonical({ key: input.key, shown_text: input.text });
}
