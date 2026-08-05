# Changelog

## 0.16.0

### Added

- **`task` and `grant` on the open — the two questions the wire could not carry.** Everything else
  Heron is missing, a vendor can close by sending more. These two could not be: *what the agent was
  allowed* had no field at all, and *how a run links to other runs* had only the session id and chain
  position, so "these four runs were one job" was not expressible even in principle. Heron reserved
  both; this is the side that fills them.

  - `openGuardedSession({ task, grant })` and `HeronClient.openSession({ task, grant })`. Stated once,
    at the open, because a delegation restated per call is one that can differ between two calls of
    the same run — and no reading of that disagreement is honest. If the authority genuinely changes
    mid-flight, that is a new run.
  - `task: { ref, parentSessionExternalId? }`. The reference is hashed into the session's genesis
    record and never published: a reviewer sees a number local to their page, so several runs link by
    their digests matching while the id stays in your namespace. An address there is refused with a
    `400`, like `principal.ref` — a value scrubbed quietly would stop matching the one you sent, and
    two runs of one job would stop linking for a reason invisible from both sides.
  - `grant: { document, ref?, scope? }`. `document` is the **document**, not a digest, for the reason
    `resolveStepUp({ shownText })` takes the text: the hashing happens in one place no call site can
    forget, and the document never crosses. It is hashed with `hashCanonical` (RFC 8785), so an object
    straight out of your own store is safe to pass — key order will not decide whether you can
    reproduce the digest a month later.
  - `scope` is the optional machine-readable half, written in Heron's own classification classes
    rather than a delegation language of ours — so a check, when it exists, is a comparison between
    two things the published record already holds. An absent key means *unbounded on that dimension*;
    an empty list is refused, because `[]` cannot say whether you meant "nothing is allowed" or "this
    is not bounded", and a delegation is the last document to guess in.
  - `taskPayload`, `grantPayload` and the types are exported for a runtime that opens its own
    sessions.

  **Unkeyed, unlike `shown_text_hash`, and the difference is the pre-image.** A delegation document is
  your own configuration, so its digest sits with `instructions_hash` — published, and safe to
  publish. A confirmation prompt is prose about a person, which is why that one is keyed.

  **Both are inert, and that is the design rather than an unfinished edge.** Neither reaches a
  verdict. A grant is the audited party describing its own limits, so a rule turning on it would make
  omitting it the cheapest way to avoid the rule; and reaching beyond a named set is a fact and not a
  fault — an agent that resolves a tool at runtime is doing its job. Heron publishes how much of a
  window stated anything, and counts no breach.

  Needs a Heron that accepts the fields (the app from 05.08.2026); an older one rejects the open with
  a `400`, so that side goes first.

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
