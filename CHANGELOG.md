# Changelog

## 0.18.0

### Fixed

- **An anchor over a *list* of recipients is tokenised, instead of being dropped.** `reduce()`
  handled only a string, so `cc`, `bcc` and `extra_recipients` — the shape almost every send API
  actually uses — never crossed at all. Nothing leaked by it (a key that is not a string simply did
  not travel), but the loss was invisible in the worst place: an email with one address in `to` and
  two hundred in `bcc` reached Heron as a single-recipient send, and the recipient comparison anchors
  exist for saw one name where the call named two hundred and one. Heron's reader already walks
  arrays, so the tokens land the moment they are sent.

  A non-string entry inside such a list is **dropped, not passed through**. Preserving the length by
  copying the odd entry verbatim would put a raw value on the wire under a key the contract promised
  was anchored — a reduction may fail by carrying less and never by carrying more. Nor is the count
  lost: `recipient_count` is computed by the edge classifier from the *raw* arguments, before any
  reduction happens.

## 0.17.0

### Added

- **`NOT_ATTEMPTED`, and `session.reportUnattempted()` — the calls your own side stops.** Your
  platform already refuses calls before Heron is asked: a rate limit, a budget, a tool a viewer may
  not run, an agent that changed its mind between choosing the tool and reaching it. None of it
  reaches the record — no action, no verdict, nothing to pair — so the safest thing your platform
  does is the one thing it cannot show. On Theona's production that population is **1.9% of all
  calls**.

  - `reportUnattempted(call, { errorCode?, signals? })` submits the action the way `decide()` would
    — same contract, same reduction, same edge classifier, so nothing crosses the boundary that
    would not have crossed anyway — and files a `NOT_ATTEMPTED` statement against it.
  - It returns an `UnattemptedReport`, **not** a `GuardDecision`. Every branch of that type is
    something a caller acts on, and handing one back for a call that has already been refused is an
    invitation to un-refuse it on a verdict nobody asked for. What you get instead is two ids for
    your own logs and `wouldHaveBeen`: the verdict for a call nobody made. Read it as *what the
    policy would have said* — an `ALLOW` means your own limit stopped something the published policy
    permits, which is the cheap way to watch two rulebooks diverge.
  - `NOT_ATTEMPTED` is also the right outcome on the after-hook for a call you decided and then
    dropped, so `report()` takes it too.

  **It fails the opposite way to everything else here, and that is deliberate.** `decide()` fails
  closed because a run is waiting on its answer. Here the call is already not happening, so failing
  closed could only break a refusal path that was working: an unreachable Heron costs you the row
  and never a run, which is exactly what happens to every one of these calls today.

  **Say it rather than saying nothing.** Silence is published as `MISSING_EXECUTION` — a finding
  about your reporting, raised over a call that never happened, and a false row costs more than a
  missing one where an accuracy figure is measured. `NOT_ATTEMPTED` claims nothing about the verdict,
  so it can never stand in for `BLOCKED`; and Heron counts it in a bucket of its own rather than
  folding it into silence, so stating it is never worse for you than staying quiet.

  Needs a Heron that accepts the outcome (the app from 06.08.2026); an older one answers the
  statement with a `400`, so that side goes first.

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
