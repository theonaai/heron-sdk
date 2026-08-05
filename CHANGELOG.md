# Changelog

## 0.15.0

### Added

- **`shown_text_hash` — commit to what the human was actually shown.** A person approving is already
  the strongest thing in the record: a new action naming the step-up it answers, signed and chained,
  with the decision stated rather than assumed. What none of it said is what that person was looking
  at, and the two ends of that range leave the identical trace — *"Send this contract to 240
  recipients outside your company?"* and *"the agent would like to continue — OK?"* produce the same
  signals, the same classification, the same receipt. A decision and a rubber stamp were
  indistinguishable in the one place a reviewer goes looking for a human.

  - `resolveStepUp({ ..., shownText })` takes the **text**, not a digest, and hashes it with the key
    the client already holds. `StepUpResolver` may return `shownText` too, so the `wrap()` path
    carries it without a second call site.
  - `HeronClient.shownTextHash(text)` for the paths that build their own signals — an approval your
    own UI collected before Heron was asked, most of all, since that is where a confirmation prompt
    of your own design lives.
  - `shownTextHash({ text, key })` and `SHOWN_TEXT_SIGNAL` are exported for a runtime that does not
    use the client, and `ShownTextSignals` gives the key a typed slot so a typo cannot become a
    commitment sent to nobody.

  **It is keyed, and that is the substance rather than hardening.** Heron publishes only *that* you
  committed — never the digest — but `signals_hash` is published, and a confirmation prompt is a
  template with a name and an amount dropped in. An unkeyed digest is a confirmation oracle for
  anyone already holding a candidate address. Use `pseudonymSecret`, which is already load-bearing
  and already retained, so this adds no new way for the proof to evaporate.

  **Not an HMAC**, which is the reflex and the wrong instrument: every `sha256:` value in this record
  is a plain SHA-256 over canonical bytes and the prefix is a promise about how to recompute it. What
  the construction needs is hiding and binding, both of which a hash over a canonical pre-image
  containing the key gives; authentication under a key the verifier does not hold is not part of the
  problem, since by the time anyone checks this you have handed them both fields.

  Requires Heron accepting the key (heron-next #139). Nothing signed or hashed changed, no existing
  call site moves, and an approval sent without it is recorded exactly as before — published as an
  answer nothing states the grounds for, which is the honest reading.

## 0.14.1

### Fixed

- **`openGuardedSession` now reads the `head_hash` that `POST /v1/sessions` returns and seeds the
  session store with it.** It was discarding the open response, so the store had no head when the
  first action reserved its position and `beforeAction` omitted the `chain` block entirely. Two
  consequences, both now closed:

  - **A dropped first action was undetectable.** Nothing claimed a link to the session's genesis, so
    a vendor that never submitted the first action of a session left a hole Heron could not see —
    the chain simply started wherever the vendor chose to start it.
  - **A stale in-process head produced false `BROKEN_CHAIN` criticals.** The head lives in a map
    keyed by session id and was only ever written by `advance()`; opening a session never reset it.
    A runtime that outlived a session boundary handed the previous session's last `record_hash` to
    the next session's first action, which reconciliation reads as a `prev_hash` that is not a
    member of the session's own hash set — indistinguishable from tampering.

  Nothing signed or hashed changed: `hashCanonical`, the chain record shape, the statement payloads
  and the JCS implementation are untouched. This changes only which value the client echoes back in
  `chain.prev_hash`. `SessionStore` is still `reserve`/`advance`, so a custom store keeps working
  unchanged and gets the same guarantee — `derivedSessionStore()` included. If the server returns no
  `head_hash`, no `chain` block is sent, exactly as before.
