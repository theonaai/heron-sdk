# Changelog

## 0.20.0

### Added

- **`aliases` on a catalogue entry — the other names a tool has arrived under, said by the vendor
  rather than guessed on receipt.** The catalogue joins to an action by exact name, because the name
  is what the vendor signed. So a vendor that renames a tool leaves its old traffic undescribed
  forever: renaming forward reaches nothing that already ran. Measured on one production window,
  that was 2 919 calls across 85 tools missing the catalogue on letter case alone —
  `execute_agent` against `EXECUTE_AGENT` being 1 410 of them by itself.

  ```ts
  await client.publishToolCatalog([
    { name: "EXECUTE_AGENT", signals: { op: "execute" }, aliases: ["execute_agent"] },
  ])
  ```

  The alternative was normalising both sides on receipt, and it is what this key exists to avoid:
  matching a signed name loosely is how a signature stops meaning anything, and it would merge two
  tools a vendor deliberately spells apart. An alias is still an exact comparison — against a name
  the vendor put inside the bytes they signed, dated by the catalogue that carries it and published
  to the reviewer with everything else.

  **A `v: 1` addition, not a format break.** A catalogue stating no aliases canonicalises to the
  bytes it always did, so every `catalog_hash` a receipt already names still resolves.

  Two rules decide the cases where an alias could attach the wrong facts to a call, and
  `resolveCatalogEntry` is pure and total under both: a **live tool always beats somebody else's
  alias** (a retired name later reused by a different tool gets that tool's own entry), and an
  **alias claimed by two entries resolves to nothing** rather than to whichever sorted first — the
  call is then classified from its name, exactly as an unlisted tool is.

- **`catalogConflicts()`** — what a catalogue states that cannot be honoured, so the server can
  refuse a broken one at the door instead of storing claims that silently do not resolve. It sits
  beside the resolution it protects: a second copy of this rule on the server is one refactor away
  from disagreeing with what a reviewer's `resolveCatalogEntry` reads.

  ```ts
  const { refuse, report } = catalogConflicts(catalog)
  if (refuse.length) return 400 // `ambiguous`, `duplicate_name`
  for (const c of report) warn(c) // `shadowed` — honest to tell, wrong to refuse over
  ```

  **The fatal/advisory split is the return shape**, because the natural door-check over one flat
  list — refuse if it is non-empty — would reject exactly the advisory case the design requires
  accepting: the vendor whose retired name is now a live tool, who would otherwise be unable to
  publish anything about their current tools until they tidy their rename history. A distinction the
  server gets wrong by writing the obvious thing is a distinction stated in the wrong place.

### Fixed

- **A catalogue's canonical bytes no longer depend on the host's locale.** `buildToolCatalog()`
  sorted tool names with `localeCompare()`, which answers from the runtime's ICU locale and build:
  a default locale orders `execute_agent` before `EXECUTE_AGENT`, `da_DK` disagrees, and a runtime
  built `--without-intl` degrades to code units. Two replicas stating identical facts could
  therefore reach different bytes — a different `catalog_hash`, a different idempotency key, and a
  published "change" that was only a re-ordering. Sorting is now by UTF-16 code unit, the order
  `canonicalize()` already puts object keys in.

  A catalogue whose names collate the same either way — which is any catalogue not mixing case or
  separators at the sort boundary — hashes exactly as before. One that does not was never
  reproducible across hosts to begin with, and re-publishing it on boot restores it under a hash
  every replica now agrees on.

  **Expect one catalogue "change" that changed nothing**, on any vendor whose names mix case — which
  is the common case, and certainly the vendor this release was written for: `EXECUTE_AGENT`,
  `execute_agent`, `ATTIO_FIND_RECORD` and `attio_find_record` sort into a different order than
  before. The first publish after upgrading writes a new catalogue row and moves the project's
  pointer to it while asserting exactly the same facts. Nothing already issued is affected — rows are
  immutable and never deleted, so every `catalog_hash` a receipt names still resolves to the bytes it
  was judged under. It is worth knowing before it appears on an evidence page, where a new catalogue
  beside identical claims otherwise reads as a vendor quietly restating itself.

- **`catalogConflicts()` reads a catalogue it did not build the way resolution reads it.** It
  runs over whatever bytes arrived, so it now applies the same de-duplication and self-name filter
  as canonicalisation: a hand-signed catalogue repeating an alias, or naming its own tool, is no
  longer refused as `ambiguous` over something `resolveCatalogEntry` answers without difficulty.

- **`buildToolCatalog()` throws on two entries for one tool**, the only input it refuses. Sorting is
  stable, so such a pair landed in the vendor's enumeration order — the one thing canonicalisation
  exists to keep out of the bytes. Silently, that is two hashes for one registry and two answers to
  one question: `buildToolCatalog([internal, external])` and the same pair reversed hash differently,
  and `resolveCatalogEntry` then answers `internal` on one replica and `external` on the other. The
  same machine-dependence this release removes for collation, arriving through the registry instead.

  There is no honest canonical form to choose here — the entries disagree, and picking between them
  would be inventing the fact rather than stating it. So it is raised at the vendor's own boot, by
  name, where it is cheapest to see and fix. `catalogConflicts()` reports it as `duplicate_name` in
  `refuse` for the bytes it did not build, which is now the only way one can arrive.

- **An alias that is both double-claimed and shadowed is reported as `shadowed`, not `ambiguous`.**
  A live tool's own name already decides the resolution before the alias pass is reached, so the
  fatal reason was refusing catalogues over a case that carries no ambiguity — the same vendor
  stranded on their rename history that the non-fatal rule exists to release.

- **`resolveContract()` breaks a tie by code unit as well**, for a reason one step past the
  catalogue's: this order does not feed a hash, it decides **which contract wins** — and with it
  `keep`, the allowlist saying what may leave the vendor's boundary at all. Under `localeCompare()`
  two builds of Node disagreed about that. `ATTIO*FIND_RECORD` and `ATTIO_FIND_RECOR*` both match
  `ATTIO_FIND_RECORD` with sixteen literal characters each, and every ICU locale orders that pair the
  opposite way from a runtime built `--without-intl`; the two replicas would then send different
  fields for the same call. The tie is reachable only between globs — an exact name is unique, and
  `server:`/`provider:` keys match by equality, so at most one of each can match a call.

  A vendor whose contract map has no two equally specific keys for one tool — which is most of
  them — resolves exactly as before.

## 0.19.0

### Added

- **`instructions` on the guard — the commitment sent once, not threaded through every call site.**
  `instructionsHash()` has existed since 0.15.0 and the wire has accepted `instructions_hash` for as
  long; what was missing was anywhere to put it that was not *every* `decide()` in the integration.
  The first vendor to send it wrote its own `withInstructions()` wrapper around three call sites, and
  every later one would have written the same thing.

  ```ts
  const session = await openGuardedSession({
    // …
    instructions: () => ({ system: agent.systemPrompt, plan: agent.planBlock }),
  })
  ```

  It reaches all three doors an action goes through — `decide`/`decideTurn`, `resolveStepUp` and
  `reportUnattempted` — because coverage is published per action, and a runtime committing on some
  submissions and not others is exactly the shape that hides a rewrite.

  **A function, not a value.** The slot is what changes: compaction rewrites it on most turns, and
  that rewrite is the whole reason the commitment exists. Captured at open, it would publish
  *unchanged* straight through one — a false statement about your own agent, in a record nobody can
  correct afterwards.

  It merges *under* everything else, so an explicit `signals.instructions_hash` still wins as the
  narrower statement about that submission. It still feeds no rule (`instructions_hash` is outside
  `SIGNAL_KEYS` by construction), and a throw from the callback is reported to `onError` and
  swallowed — a diagnostic that gates nothing must not be able to fail a tool call.

## 0.18.0

### Added

- **`resource` on a tool contract — the key that links two sessions through the object they both
  touched.** `HeronClient.beforeAction` has accepted `resourceRef` since v1 and the guard never
  filled it, so every vendor on the documented path reported `resource_ref` on **0%** of calls and
  read as having declined to send it. It is now a function of the call, resolved with the same
  specificity rules as `keep`/`anchors`/`signals`:

  ```ts
  "gmail.send": { resource: ({ args }) => String(args.thread_id) }
  ```

  **Opaque ids only.** It is stored and published as given, and unlike `principal.ref` nothing at
  Heron's door refuses one that looks like an address — so a calendar entry keyed by attendee, or a
  document keyed by its title, would put the very thing anchors exist to tokenise on the wire in the
  clear. Where the natural handle is not opaque, return nothing rather than a digest of your own: an
  unkeyed hash of a short title is not hiding it.

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
