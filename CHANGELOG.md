# Changelog

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
