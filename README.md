# @theonaai/heron-sdk

The vendor side of Heron: one hook before every agent tool call, one signed statement after it.
Framework-agnostic, and free of any server dependency — installing this does **not** pull in a
database or the Heron app. Its only runtime dependencies are `@noble/hashes` and `@noble/ed25519`.

## Install

Published to the public npm registry — no registry configuration, no token:

```bash
npm i @theonaai/heron-sdk
```

The scope is `@theonaai`; it names who publishes the package, not who the SDK is for. Any vendor
integrating Heron installs this one.

## Quickstart

```ts
import { HeronClient, openGuardedSession } from "@theonaai/heron-sdk";

const heron = new HeronClient({
  baseUrl: "https://heron.example",
  apiKey: process.env.HERON_API_KEY!,
  vendorKid: process.env.HERON_VENDOR_KID!,
  vendorSeed: process.env.HERON_VENDOR_SEED!,   // Ed25519 seed — stays on your side, always
  pseudonymSecret: process.env.HERON_PSEUDONYM_SECRET!,
});

const guard = await openGuardedSession({
  heron,
  contracts,                                    // the reduction, declared once per tool (below)
  agent: { externalId: "billing-agent", version: "2.1.0" },
  principal: { type: "human", ref: "user_881" },
  request: userRequest,                    // stays on the edge; only its hash + anchor tokens cross
  sessionExternalId: runId,
  task: { ref: jobId },                    // optional — which job this run belongs to
  grant: { document: delegationRecord },   // optional — what it was allowed; hashed here, never sent
  onStepUp: async ({ tool }) => showApprovalUI(tool), // your human-approval channel
});

const guardedTools = guard.wrap(myTools);       // { name, run }[] — call them like any other tool
// ... run the agent over guardedTools ...
await guard.close();
```

`guard.wrap` carries the whole loop — reduce → ask Heron → honour the verdict (`ALLOW` runs,
everything else does not) → report signed execution evidence, including when your tool throws — and
threads the chain for you. The agent just calls tools.

## When `wrap` does not fit — which is most platforms

`wrap` assumes a tool call begins and ends inside one function call. Two things break that
assumption in practice, and both are ordinary rather than exotic:

- **Approval ends the run.** Most platforms surface a call that needs a human as an interruption,
  finish the run, and execute it later in a *new* run — often on another machine.
- **A worker can be replaced** mid-turn, and the next one resumes the same conversation.

So the primitive is not the wrapper, it is a decision you can act on:

```ts
const decision = await guard.decide({ name: toolName, args });

switch (decision.kind) {
  case "run":     /* execute, then guard.report({ ...decision, outcome: "EXECUTED", result }) */ break;
  case "step_up": /* surface an approval; nothing is held open on our side */ break;
  case "modify":  /* decision.transform names a narrowing — submit the narrower call as a new one */ break;
  case "defer":   /* decision.pending names context to establish first */ break;
  case "blocked": /* do not run. Includes Heron being unreachable — see below */ break;
}
```

If your own UI already cleared the call with a human *before* Heron ever saw it — an approval prompt,
a four-eyes check — say so on the submission, or the fact is lost:

```ts
await guard.decide({ name, args, id: toolCallId }, { human_authorized: true, approver: reviewerId });
```

That answers no step-up of *ours*, so it names no action. It is recorded and published, because "was
a person involved, or did the agent do this alone?" is the first question asked of an executed
action — and it **never lifts a verdict**. There is no action of ours to check it against, and if an
unverifiable boolean could lift a STEP_UP, every human gate in the system would have a one-key
bypass. A call that Heron itself steps up still waits for the answer to *that* step-up.

Which is the other shape, and it is checkable, so it does lift:

```ts
await guard.decide(
  { name, args, id: toolCallId },
  { resolves_action: priorActionId, human_decision: "APPROVE", approver: reviewerId },
);
```

`resolves_action` is not optional decoration: the classifier reads an approval only when it knows
which step-up is being lifted. The keys are typed as one statement, so an incomplete form is a
compile error here and a `400` at the API — the one outcome worse than no approval is an approval
the verdict silently ignored while your code believes it was counted. These signals are merged last,
so they beat both the tool's contract and the edge classifier.

When the human answers a step-up *Heron* raised — in whatever process — you submit the answer as a
new action instead:

```ts
await guard.resolveStepUp({
  actionId,
  call: { name, args },
  approved,
  approver: reviewerId,
  shownText: promptYouRendered,   // the text, not a digest — see below
});
```

`shownText` is what your confirmation UI actually put in front of that person. It is digested here
with your own key and only the digest crosses; pass it and an approval is bound to its prompt, omit
it and the approval is recorded exactly as before — as an answer nothing states the grounds for.

## The calls your own side stops

Your platform already refuses calls before Heron is ever asked: a rate limit, a budget, a tool a
viewer may not run, an agent that changed its mind between choosing the tool and reaching it. Those
calls live in your logs and nowhere else — no action, no verdict, nothing to pair — so **the safest
thing your platform does is the one thing its record cannot show**.

```ts
const { wouldHaveBeen } = await session.reportUnattempted(
  { name, args },
  { errorCode: "rate_limited" },   // your vocabulary, never read by a rule
);
```

It submits the action exactly as `decide()` would — same contract, same reduction, same edge
classifier, so no argument crosses that would not have crossed anyway — and files a `NOT_ATTEMPTED`
statement against it: *the agent asked for this, and it did not happen.*

Three things worth knowing before you wire it:

- **`wouldHaveBeen` is a measurement, not clearance.** It is the verdict for a call nobody made, and
  it is the cheap way to see your own limits and your published policy diverging: an `ALLOW` means
  your limit stopped something the policy permits, a `DENY` means the two agree.
- **Nothing is gated on it and nothing throws.** The call is already not happening, so an
  unreachable Heron costs you the row and never a run — the opposite of `decide()`, which fails
  closed because something is waiting on its answer. Call it after you have answered the model.
- **Say it rather than saying nothing.** Silence is published as `MISSING_EXECUTION`, a finding
  about *your reporting*, raised over a call that never happened. `NOT_ATTEMPTED` claims nothing
  about the verdict — it can never stand in for `BLOCKED` — and Heron counts it apart from silence,
  so stating it is never worse for you than staying quiet.

The same outcome is the right one on the after-hook for a call you decided and then dropped:
`session.report({ actionId, decisionId, outcome: "NOT_ATTEMPTED" })`.

## The job a run belongs to, and what it was allowed

Two optional fields on the open, and the only two facts Heron's wire could not carry at all until
0.16.0 — everything else it was missing, a vendor could close by sending more.

```ts
await openGuardedSession({
  // …
  task: { ref: jobId, parentSessionExternalId: parentRunId },
  grant: {
    document: delegationRecord,          // your own policy/ticket/approval — hashed here, never sent
    ref: "delegation_2261",              // a pointer into your system; opaque, never interpreted
    scope: {                             // optional, and the half a checker can actually read
      allowedTools: ["crm.get_customer", "gmail.send"],
      bounds: { operation: ["read", "send"], destination: ["internal"] },
      expiresAt: lapsesAt,
    },
  },
});
```

`task.ref` is how several runs read as one job. It is hashed into the session's genesis record and
never published — a reviewer sees a number local to their page — so the id itself stays in your
namespace. It is refused with a `400` if it looks like an address, like `principal.ref`: a value
Heron scrubbed quietly would stop matching the one you sent, and two runs of one job would stop
linking for a reason invisible from both sides.

`grant.document` is the **document**, not a digest, for the same reason `shownText` is the text —
the hashing happens in one place nobody can forget. It is unkeyed, unlike a confirmation prompt,
because a delegation document is your own configuration rather than prose about a person. Inside
`scope`, an absent key means *unbounded on that dimension*; an empty list is refused, since `[]`
cannot say whether you meant "nothing is allowed" or "this is not bounded".

Both are committed at the open, so what a run claimed about its own authority cannot be restated
after it misbehaves — and **both are inert**. No rule reads either, and no verdict changes because
you sent one. Heron publishes how much of a window stated anything and counts no breach: reaching
beyond a named set is a fact and not a fault, and an agent that resolves a tool at runtime is doing
its job.

`decide()` never blocks on a person and never throws because Heron is down. **There is no fail-open
option, deliberately**: a policy gate that throws hands you an exception where you asked for a
verdict, and the reflex around every tool call is to log an exception and carry on — which is the
bypass. If Heron cannot decide, the decision is `blocked`. The audited way to keep running through
an incident is Heron's own break-glass, which is signed and published on the evidence page.

Fail-closed makes an outage expensive in *latency*, not just in verdicts: every call would otherwise
pay the full retry budget for an answer that was never going to arrive, and across one turn's
fan-out that is seconds per turn. So the client stops asking after five consecutive unanswered
requests, waits thirty seconds, and lets exactly one through to check:

```ts
new HeronClient({
  // …
  breaker: {
    threshold: 5,
    cooldownMs: 30_000,
    onOpen: (i) => log.error(i, "Heron stopped answering; not asking again until the cooldown"),
    onClose: () => log.info("Heron is answering again"),
  },
  // breaker: false,   // to disable it
});
```

**This changes latency, not posture.** A request that fails and a request never made produce the
same thing — no action on the chain, no verdict, the same `blocked` answer — so it cannot turn a
refused call into a permitted one. A `4xx` never counts toward it: that request was answered, by a
rejection you earned, and treating it as an outage would let one malformed contract take the guard
offline for every other call on the platform.

## State that outlives the process

The chain position defaults to memory, which is correct only if a run never outlives one process.
If yours does — see above — you have two options, and the first needs no storage at all:

```ts
const guard = await openGuardedSession({ /* … */ store: derivedSessionStore() });

// then give every call the id your runtime already has for it:
await guard.decide({ name, args, id: toolCallId });
```

`derivedSessionStore()` computes the position from the call's own identity, so there is nothing to
persist and nothing to lock — and a retry of the same call submits the same position, which makes it
a replay on Heron's side rather than a second action. The trade is that `seq` stops being a
sequence: Heron only requires it to be unique within a session and orders the chain itself, so
nothing breaks, but a reviewer can no longer read a gap in it as "the vendor numbered an action it
did not show us".

If that reading is worth durable storage to you, implement `SessionStore` over whatever you have:

```ts
const store: SessionStore = {
  // Must be atomic per session: a fan-out calls it concurrently and two calls must not get the
  // same seq. Returning the same head to both is fine — Heron checks the claim for membership.
  async reserve(sessionId) { /* UPDATE … SET seq = seq + 1 RETURNING seq, head */ },
  async advance(sessionId, recordHash) { /* UPDATE … SET head = $recordHash */ },
};
```

Without it, a resumed run restarts its counter and Heron answers `409` — `seq` is unique per
session.

## Fitting your platform's shapes

Three hooks, so that nothing in this package has to know about any particular tool bus:

```ts
const guard = await openGuardedSession({
  // …
  // Some platforms route many actions through one generic tool whose real target is in the args.
  // Heron classifies on the tool name, so unwrap it here — you are the only side that knows the shape.
  resolveCall: ({ name, args }) =>
    name.endsWith("_call_tool")
      ? { name: String(args.tool_id), args: args.parameters as Record<string, unknown>, provider: name }
      : { name, args },

  // A timeout in most runtimes abandons the call rather than cancelling it: the request is still in
  // flight, so `FAILED` would be a claim about the world. `ABANDONED` is what that case is for.
  classifyError: (e) => (e instanceof TimeoutError ? "ABANDONED" : "FAILED"),

  // The after-statement is evidence, not control flow. Hand it to a durable queue and it stops
  // costing the agent a round-trip — and stops being lost when the process dies.
  deliver: (send) => myQueue.add("heron-evidence", send),
});
```

`deliver` receives a closure, which suits an in-process queue. A **durable** queue cannot carry a
closure — it carries data — so file the statement from the worker instead, and reduce the result to
its hash *before* it goes on the queue:

```ts
import { hashResult } from "@theonaai/heron-sdk";

// …where the tool result still exists:
await myQueue.add("heron-evidence", {
  actionId, decisionId, outcome: "EXECUTED", resultHash: hashResult(result),
});

// …in the worker:
await heron.execution(job.data);   // `resultHash` is accepted in place of `result`
```

Only the hash ever reaches Heron either way. Hashing at the edge keeps the raw result out of the
queue as well — otherwise durability is bought by storing a second copy of your users' data in your
broker, to compute a value you were going to reduce to 32 bytes anyway.

## The contract map — the one thing you write

A tool's *contract* is how its call is reduced before it crosses the boundary, declared once (not per
call). It is the only integration code that is genuinely yours, because it encodes facts only you can
know — Heron is never allowed to see the raw request (that is the point of the product).

```ts
import type { ContractMap } from "@theonaai/heron-sdk";

const contracts: ContractMap = {
  "gmail.send": {
    keep: ["subject"],                 // allowlist: only these arg keys travel (redacted)
    anchors: { to: "email" },          // tokenised on the edge — the address never crosses
    signals: ({ args }) => ({
      op: "send",
      recipient_external: !String(args.to).endsWith("@acme.example"),
      recipient_count: 1,
    }),
  },
  "crm.get_customer": { keep: ["customer_id"], anchors: { email: "email" } },
};
```

An anchor key holding a **list** is tokenised entry by entry — `anchors: { to: "email", cc: "email",
bcc: "email" }` covers the shape most send APIs use. An entry inside the list that is not a string is
dropped rather than copied through: a key the contract calls an anchor never crosses raw, whatever
shape it arrives in.

`signals` are typed against `SignalKey` (`SIGNAL_KEYS`): a signal the classifier does not read will
not compile. Each key's `derivable` field says whether Heron can fall back to deriving it from the
tool name (`"full"`/`"partial"`) or whether the fact is pinned to your side (`"none"` — a recipient, a
human's approval). See the trust-boundary notes in the Heron repo.

### A key can name a group, not just a tool

A platform does not have twelve tools. The first production window of the first integration carried
**228 distinct tools and not one declared `data_class`** — the dimension that decides the credential,
money and personal-data rules. Not because the vendor disagreed with any of them: because saying it
meant writing 228 contracts. So a key is any of four things, and the last three cover a fleet:

```ts
const contracts: ContractMap = {
  "gmail.send": { keep: ["subject"] },                              // one tool, exactly
  "ATTIO_*": { signals: () => ({ data_class: "personal" }) },       // a glob over tool names
  "server:stripe": { signals: () => ({ data_class: "financial" }) },// everything on that server
  "provider:composio": { keep: [] },                                // everything from that provider
};
```

Resolution is by specificity — exact name, then the glob with more literal characters, then
`server:`, then `provider:` — and **never** by the order you wrote the keys in: a signal is signed
testimony, and "it depended on which key came first" is not an answer you can give a reviewer. The
merge is per *field*, so `"ATTIO_CREATE_RECORD": { keep: [...] }` beside `"ATTIO_*": { signals }`
keeps the group's signals on that tool. Allowlists are never unioned: the most specific `keep` wins
whole, so a wide key can never widen what leaves your boundary. `resolveContract(call, contracts)` is
exported if you want to see what a call resolves to.

**What you are signing.** A signal crosses as `declared` — your testimony, pinned by `args_hash` —
and `declared` *overrides* Heron's own derivation. `"ATTIO_*": { data_class: "personal" }` asserts a
fact about your integration that Heron cannot see, which is exactly what the vocabulary is for. What
it is not is a cheaper way to look well-classified: a wide key declaring a class you have not checked
is a signed falsehood, it takes those calls out of the rules that would have caught them, and the
evidence page reports it as vendor-asserted. Narrow keys you can defend beat one key that covers
everything.

**A signal is about *this call*; a tool catalogue is about the tool.** If you publish one (`PUT
/v1/tool-catalog`), what it says crosses as `catalogued` — ranked above `derived`, because you signed
it, and below `declared`, because no catalogue entry can know that *this* invocation went to an
outside recipient. Put the tool's standing facts there and keep `signals` for what varies per call;
the per-call signal wins where both speak, and the evidence page counts the two apart.

## The reference edge classifier — the signals you do not have to write

Most of the `signals` above are mechanical: how many recipients, how many records, whether an address
is outside your perimeter. The guard reads them off each call's arguments for you.

**It is on by default**, and with no options it claims counts and nothing else — `recipient_external`
needs a perimeter only you know, `amount` needs a unit that has no safe default, and neither is
guessed. Two options turn those on:

```ts
const guard = await openGuardedSession({
  // …
  edge: {
    internalDomains: ["acme.example"],   // without it, recipient_external is not claimed at all
    amountInMinorUnits: true,            // without it, amount is not claimed at all
  },
  // edge: false,                        // or turn the classifier off entirely
});
```

**If you are multi-tenant, `internalDomains` is a function.** "Inside" belongs to the customer whose
agent is running, not to your process. One global list declares your own staff internal to somebody
else's agent — and since the signal crosses as `declared`, that is a signed falsehood which *also*
drops the call out of the external-send rule that would otherwise have caught even `unknown`:

```ts
edge: {
  internalDomains: (ctx) => perimeterFor(ctx.principal?.ref),   // undefined ⇒ nothing is claimed
}
```

The context carries the tool, provider, server, principal and session id — everything the guard
already knows, none of which crosses the boundary because of this. Returning `undefined` for a tenant
you cannot resolve is the right answer: an `unknown` a reviewer can see beats a guess they cannot.

It used to be opt-in, and the first integration reasonably left it off — the only setting anyone
reads about is `internalDomains`, that one genuinely does not generalise across a multi-tenant
platform, and so the whole classifier stayed dark. The result was `magnitude: unknown` on every
action and a bulk rule that never fired, for a reason unrelated to bulk.

It then fills `recipient_count`, `record_count`, `recipient_external` and `amount` from conventional
argument keys (`to` / `cc` / `bcc` / `recipients`, `ids` / `records` / `items`, and for money only
unambiguous names — `amount` / `amount_minor` / `total_amount` / `price`, never a bare `value` or
`total`, which are ordinary words for ordinary arguments),
which you can redirect with `fields`.

Those keys are looked for **wherever they are**, not only at the top level: through a tool bus's
envelope (`{ params: { to: … } }`), through a message object, and through the objects in a batch, so
a list of messages each with its own recipient counts as the recipients it has. Reading only the top
level was measured against a real window and emitted a signal on 0.8% of calls — the keys were there,
nothing looked at them. A value found at a key is the answer for that key and is never descended into
as well, so a recipient list is counted once; depth and total nodes are bounded, because this runs on
the path of every tool call. A tool's own `contract.signals` always wins — the classifier
only fills what you left out — and `classifyAtEdge(args, options)` is exported if you would rather
call it yourself.

**What it will not do, deliberately.** It reads your *arguments*, never the tool name. Anything a tool
name reveals — the operation, whether the call is reversible, whether the data is financial — Heron
derives itself and publishes as `derived`, an honest admission that it guessed. Shipping that same
guess as a signal would repaint it `declared` on the evidence page without adding any information,
and the reviewer's signal-source counter exists to catch exactly that. It also leaves `data_class`
alone: an email in the arguments does not tell anyone whether the payload is personal data, and a
`declared` signal overrides Heron's derivation — claiming `personal` on a refund because a receipt
address is in the args would drop `financial` and take the call out of your money rule. That one
stays yours.

## Public API

The root export carries the vendor surface:

- `HeronClient`, `HeronUnavailableError`, `mayExecute`, `hashResult` — transport and the honour rule.
  `mayExecute(verdict, effect?)` takes the decision's `effect`, so a declared shadow window runs the
  call without the vendor keeping a switch of its own (below).
- `openGuardedSession`, `reduce`, `resolveContract`, `defineContract`, `derivedSessionStore`, `memorySessionStore` — the guard layer.
  `session.reportUnattempted(call)` records a call your own side refused before the guard was asked;
  `UnattemptedReport` is what it hands back.
- `SIGNAL_KEYS`, `SIGNAL_KEY_LIST`, `SignalKey` — the signal vocabulary.
- `INTENT_TAXONOMY`, `INTENT_TAXONOMY_DOCUMENTATION`, `INTENT_PROMPT`, `INTENT_PROMPT_HASH`,
  `INTENT_PROMPT_VERSION`, `buildIntentQuestion`, `parseIntentAnswer`, `intentSignals`,
  `stripMeasured` — the fork: the versioned vocabulary, generated question and documentation, and
  the parsing of what comes back. `session.decideTurn()` drives all of it.
- `instructionsHash`, `INSTRUCTIONS_SIGNAL` — the commitment to your agent's governing text.
- `shownTextHash`, `SHOWN_TEXT_SIGNAL` — the commitment to what a human was shown before approving.
  `HeronClient.shownTextHash(text)` is the call to reach for: it holds the key for you.
- `taskPayload`, `grantPayload`, `SessionTask`, `SessionGrant`, `GrantScope`, `GrantBounds` — the job
  a run belongs to and the authority it was given. `openGuardedSession({ task, grant })` is the call
  to reach for; these are for a runtime that opens sessions itself.
- `classifyAtEdge`, `EdgeClassifierOptions` — the reference classifier over a call's arguments.
- `pseudonymWith`, `replaceAnchors`, `collectAnchors`, `ANCHOR_PATTERNS`, `AnchorType` — edge tokenisation.
- `buildExecutionEvidencePayload`, `ExecutionEvidencePayload` — the statement you sign.
- `buildToolCatalog`, `catalogHash`, `resolveCatalogEntry`, `catalogConflicts`, `CatalogEntry` —
  what your tools *are*.

The signed-bytes core is also reachable through stable subpaths, for a consumer that recomputes a
receipt or a chain from the published bundle — this is how the Heron app and `verify-receipt` reuse
the exact functions a vendor signs with:

```ts
import { canonicalize } from "@theonaai/heron-sdk/crypto/jcs";       // RFC 8785
import { hashCanonical, chainRecordHash } from "@theonaai/heron-sdk/crypto/hash";
import { signCanonical, verifyCanonical } from "@theonaai/heron-sdk/crypto/ed25519";
```

Also exported as subpaths: `@theonaai/heron-sdk/contract`, `.../edge-classify`, `.../pseudonym-core`,
`.../statements`, `.../tool-catalog`, `.../policy/taxonomy`.

## Shadow windows are told to you, not configured here

A `decision` carries `effect` beside its `verdict`:

- `"enforced"` — honour the verdict before executing. This is the default and the only reading of a
  missing field, so a Heron older than the field, or an answer that never arrived, behaves exactly as
  it always did.
- `"advisory"` — the project has declared a shadow window on Heron's side. Run the call anyway and
  report what happened; the execution is published as a **rehearsal**, not as a breach.

`openGuardedSession` already does this for you: an advisory decision comes back as
`{ kind: "run", rehearsed: true }`, and the flag is worth logging — it is the list of calls that will
stop the day the vendor declares enforcement. If you call `mayExecute` directly, pass the effect:

```ts
if (mayExecute(before.decision.verdict, before.decision.effect)) {
  await runTheTool()
}
```

**Do not keep a shadow switch of your own.** It was the obvious design and it has a failure mode we
have now watched happen: a deployment held the right value in its own environment variable, never
declared the same thing in Heron, and its evidence page published 576 rehearsals as breaches of a
promise nobody had made. The declaration has to live where it cannot be made by the runtime being
checked — a runtime in shadow would declare shadow, truthfully, on every call, and there would be no
breach left to find. So it is an operator's statement in Heron, dated and signed into every decision
receipt as `enforcement.effect`, and this field is how it reaches you.

Being *told* a verdict is advisory is a signed statement about one action. Not being able to ask is
nothing at all, and the two must never converge: with no answer there is no effect, and the guard
fails closed exactly as before. There is still no fail-open switch in this SDK.

## The tool catalogue — what your tools are, as opposed to what one call did

A `signals` object describes one **call**. The catalogue describes one **tool**, and Heron treats the
two differently on purpose: a per-call signal always wins, and a catalogue entry is asserted for
every call that tool will ever serve.

It matters because of what happens when you send nothing. Heron then works the dimension out from
the tool's **name** and publishes it as `derived` — which reads to your reviewer as an independent
inference and is not one: the name is a string you chose. A catalogue is the same knowledge under
your key, with a date on it.

```ts
await heron.publishToolCatalog([
  { name: "SESSION_MEMORY_WRITE", signals: { op: "write", destination: "internal" } },
  { name: "APOLLO_PEOPLE_ENRICHMENT", signals: { op: "read", destination: "third_party", data_class: "personal" } },
  { name: "send_email", signals: {} }, // listed, and we state nothing — see below
])
```

Send it **on every process start**. Heron is idempotent by content: the same facts hash to the same
row, so re-sending an unchanged catalogue writes nothing, and replicas booting together are one
statement rather than a stream of duplicates for your reviewer to read past.

Three rules worth knowing before you write one:

- **Only facts that are constant for the tool.** A recipient count or an amount belongs to a call.
  `destination` is allowed because for many tools it genuinely is constant — state it where it is.
- **Reversibility has three values, not two.** `reversible: true|false` is the shorthand; where the
  honest answer is the middle one — recovery exists but is not an undo, like a record your agent
  regenerates or a file behind a backup — send `reversibility: "costly"`. Claiming `true` for that
  case overstates, and accepting `terminal` collects a verdict you did not earn.
- **An empty entry is legal, and it is not the same as silence.** Listing a tool and stating nothing
  says you have no constant fact to offer; leaving it out says your enumeration missed it. The
  evidence page shows those separately, and only the second is a bug.
- **A `200` does not mean it verified.** A bad signature is stored and reported rather than rejected —
  refusing it would delete the evidence that a vendor's signing is broken. Read `signature_valid`.

### If you have ever renamed a tool, say so — `aliases`

The join is by exact name, because the name is what you signed. So renaming a tool forward describes
nothing that already ran: every call under the old spelling stays undescribed permanently, and your
coverage number reads as a gap you cannot close by fixing your registry. One production window had
2 919 calls across 85 tools missing the catalogue on **letter case alone**.

```ts
await heron.publishToolCatalog([
  { name: "EXECUTE_AGENT", signals: { op: "execute" }, aliases: ["execute_agent"] },
])
```

Heron will not normalise names on receipt to paper over this, and you should not want it to: matching
a signed name loosely is how a signature stops meaning anything, and it would merge two tools you
spell apart on purpose. An alias is still an exact comparison — against a name **you** put in the
bytes you signed.

Two rules, so an alias can never quietly attach the wrong facts to a call:

- **A live tool always wins.** If you retire `legacy.send` and later ship a different tool under that
  name, calls to it get the new tool's own entry, never the alias.
- **An alias two tools claim resolves to nothing**, and Heron rejects such a catalogue rather than
  storing claims that silently do not resolve. Aliases are also sorted and de-duplicated before
  hashing, so the order your rename history happens to iterate in is not a change to publish.

## When a model is the one saying it

Everything above is a measurement: `classifyAtEdge` counts recipients in the arguments, your
contract states what a tool does, your catalogue states it under your key. Heron publishes all of it
as `declared` — a fact you computed.

A model's answer is not that, and sending it as `declared` would be the one substitution this
package cannot undo. The source is sealed into the published classification and the classification is
immutable, so a reviewer who cannot separate them today cannot separate them a year of receipts
later. Mark it, and Heron publishes those dimensions as `inferred` instead.

### The fork — ask your own model, and let the SDK own the question

The cheapest judge with the full context is the agent itself. Configure `intent` and decide a whole
model turn at once: the SDK composes the question, you fork your live session — same agent, same
model — and hand back the raw answer.

```ts
import { openGuardedSession } from "@theonaai/heron-sdk"

const session = await openGuardedSession({
  // …the usual options
  intent: {
    model: "claude-sonnet-5",
    slice: "last_turn",
    // Fork the session and put the SDK's question to it. Return the reply, or null to skip.
    ask: async ({ prompt }) => forkThisSession().complete(prompt),
  },
})

// One completion for the whole turn, then each call carries the claim about itself.
const decisions = await session.decideTurn(calls)
```

**The question is ours, and that is the point.** `INTENT_TAXONOMY` is the versioned source for the
closed vocabulary and every definition. The SDK generates `INTENT_PROMPT`, the parser's accepted
values, and the Markdown `INTENT_TAXONOMY_DOCUMENTATION` from it. `INTENT_PROMPT_HASH` travels on
every claim, so a reviewer holding a receipt can look up exactly what was asked. Tool catalogue
entries are never included in the question: the declaration remains an independent witness.

**The turn is the unit, not the call.** `decide()` never asks; only `decideTurn()` does. A fork per
call would multiply the cost by your fan-out and put the same question to the same context several
times over. Skip a turn that is not worth asking about — a page of reads — by calling `decide()` for
it. Measure how often it actually fires on your own traffic before you turn it on everywhere.

**Everything about it fails to silence.** A fork that throws, times out, declines, or answers
something unparseable costs the turn its claims and nothing else; the calls are decided exactly as
they would have been. That direction is deliberate: a claim only ever fills a dimension nothing else
answered, so its absence leaves the dimension `unknown` and the friction in place.

`parseIntentAnswer` accepts the legacy fenced-object and bare-array wrappers, but v2 is atomic about
content: every row must contain exactly `ref` and the four dimension fields. A missing or extra field,
duplicate ref, or unsupported value rejects the whole answer. Valid rows outside the `refs` being
parsed are ignored for compatibility with integrations that ask once per turn and parse per call.
Taxonomy `"unknown"` is a valid decline for one dimension and produces no claim for that dimension.
`magnitude` is never asked about: its signals are counts, and a count is a measurement
`classifyAtEdge` reads off your arguments.

### Or send the claim yourself

The four keys are one statement — the incomplete form does not compile, because a marked dimension
with no model named is a verdict your reviewer can count and cannot question:

```ts
import { formatInferredDimensions } from "@theonaai/heron-sdk"

await session.decide(call, {
  data_class: "personal",                                   // what the model said
  inferred: formatInferredDimensions(["data_class"]),       // …and that a model said it
  inference_model: "claude-sonnet-5",
  inference_prompt_hash: await hashPrompt(JUDGE_PROMPT),
  inference_slice: "last_turn",
})
```

If you do it this way, do what `decideTurn` does for you: **never send a claim about a dimension you
already measured.** A claim travels under the same key a measurement does, so putting one on top does
not lose the argument — it replaces the measurement in transit and marks the survivor as a model's
word, leaving Heron one value and no way to learn your edge had measured something else.

Three properties are worth knowing before you wire a judge up to this:

- **It resolves ignorance; it never contradicts.** Heron consults an inferred value only where its
  own classification came out `unknown`. A model cannot move a dimension your catalogue stated, and
  it cannot overturn what Heron derived from the tool name — so a judge that has been talked into
  lying can buy back the friction that ignorance created, and nothing that evidence established.
- **It names dimensions, never signals.** There is no spelling of `inferred` that marks
  `human_decision`, so a model can never sign off on its own step-up.
- **`inference_slice` is a label, never the text.** `"last_turn"`, `"turn_and_plan"` — how much the
  judge saw, not any of it. The conversation does not cross this boundary in any form.

And the limit, stated where you will read it rather than in a footnote: this is a defence against a
confused agent and against an injection arriving in *content*. It is **not** a defence against a
poisoned **system prompt** — a fork whose instructions were rewritten is a compromised judge
answering honestly. Which is what the next section is for.

## Committing to the agent's own instructions

Everything else you send is about a **call**. Your agent's governing text is not, and a runtime that
rewrites the system prompt or the plan block mid-session is ordinary rather than exotic — so an agent
that read an external page and then rewrote its own plan leaves exactly the trace of one that carried
on, and nobody reading the evidence can tell.

One scalar closes that. Hand the guard a way to read the slot, and every submission commits:

```ts
const session = await openGuardedSession({
  // …
  instructions: () => ({ system: agent.systemPrompt, plan: agent.planBlock }),
})
```

A function rather than a value, because the slot is precisely the thing that moves: it is read per
submission, so a rewrite between two calls is what reaches the wire. A value captured when the
session opened would publish *unchanged* straight through a rewrite — worse than sending nothing,
because it is a false statement about your own agent in a record nobody can correct.

You can still send it per call, and an explicit signal wins as the narrower statement about that one
submission:

```ts
import { instructionsHash } from "@theonaai/heron-sdk"

await session.decide(call, {
  instructions_hash: instructionsHash({ system: systemPrompt, plan: planBlock }),
})
```

Heron publishes *that the instructions changed between two commitments* — never a byte of what they
say — with the digests beside every action, so the change count is your reviewer's arithmetic rather
than anyone's claim.

- **It feeds no rule, deliberately.** `instructions_hash` is not in `SIGNAL_KEYS`, so there is no
  spelling of it that reaches a verdict. A commitment whose value could move a decision would be a
  new way to steer one, and the whole worth of this scalar is that it is inert.
- **Silence is never stability.** An action with no commitment is published as *uncommitted*, not as
  *unchanged*, and the coverage sits beside the change count. Commit on every action, or accept that
  the coverage figure says you did not.
- **A malformed digest is a 400.** It would compare unequal to everything including a later copy of
  itself and publish "the instructions changed" on every action carrying it — a false finding about
  your own agent, in a record nobody can correct. Use the helper; it hashes the two slots separately,
  so text moved from the system prompt into the plan is the change it actually is.

It is testimony: you compute the digest over text Heron never sees, so it catches *inconsistency*,
never fabrication. And it says *that* the instructions changed, never *what*.

## Warning when durable agent state looks like a credential

Instructions, memory and flow survive the call that wrote them. A credential copied into one of
those slots is therefore handed to later runs, even when no tool argument ever carries it. Inspect
the write at the edge, before saving it:

```ts
import { detectCredentialWrite } from "@theonaai/heron-sdk"

const warning = detectCredentialWrite({ target: "instructions", value: update.instructions })
if (warning) showWarning(warning)
```

The detector describes forms, not vendors: a short prefix and separator followed by a long opaque
run, long hex/base64-like values, and opaque URL values in paths as well as query strings. It walks
nested values, so the same call works for a structured flow or memory payload.

The result contains only the target and shape categories. It never contains the match, source text,
object path or an excerpt. This is also why it returns a local warning rather than a Heron signal:
instruction content stays outside `SIGNAL_KEYS`, no inspected text crosses the boundary, and no rule
can turn a heuristic owned by the audited vendor into a verdict. A warning asks a human to inspect
the write; it does not refuse or modify it.

## Committing to what the human was shown

A person approving is already the strongest thing in your record: a new action naming the step-up it
answers, signed and chained, with the decision stated rather than assumed. What none of it says is
**what that person was looking at** — and the two ends of that range leave the identical trace:

> *"Send this contract to 240 recipients outside your company?"*
> *"The agent would like to continue — OK?"*

Same signals, same classification, same receipt. So a decision and a rubber stamp are
indistinguishable in the one place a reviewer goes looking for a human. `resolveStepUp` takes the
text (above); for an approval your own UI collected before Heron was asked, commit to it directly:

```ts
await session.decide(call, {
  human_authorized: true,
  approver: reviewerId,
  shown_text_hash: heron.shownTextHash(promptYouRendered),
})
```

You cannot then restate what you showed: the digest rides in `signals`, `signals_hash` is in the
chained record, and producing the text later either recomputes to the value you committed to or it
does not.

- **It is keyed with your `pseudonymSecret`, and that is not optional hardening.** Your evidence page
  publishes only *that* you committed — never the digest — but `signals_hash` is published, and a
  confirmation prompt is a template with a name and an amount dropped into it. An unkeyed digest is
  therefore a confirmation oracle for anyone already holding a candidate address, which is exactly
  the shape the anchors exist to avoid. `HeronClient.shownTextHash()` holds the key so no call site
  can forget it.
- **It feeds no rule, deliberately** — like `instructions_hash`, it is outside `SIGNAL_KEYS`. A rule
  that fired on it would make *omitting* it the cheapest way out, so the vendor with the worst
  confirmation prompts would have the strongest reason to send nothing.
- **A malformed digest is a 400.** Unlike the instruction commitment, this one is never compared with
  anything of Heron's: its whole job is to be reproducible *later*, from bytes you still hold. One
  nobody can reproduce binds you to nothing while still publishing the approval as bound to its
  prompt, in a record that cannot be corrected afterwards.
- **Keep the text.** The commitment is worth exactly what your own retention of the prompt is worth —
  it fixes what you showed; it does not store it for you.

It says you are answerable for what you showed. It does not say that what you showed described the
call: that judgement needs the text, and the text staying on your side is the shape of this whole
integration.

## Requirements

A runtime with `fetch`, `AbortController` and `setTimeout` — Node ≥ 18, Bun, Deno, Workers, or a
browser. `tests/sdk-portable.test.ts` fails the build if any `node:*` built-in becomes reachable from
this package, because "Node ≥ 18" is an assumption about *your* infrastructure that we are not
entitled to make.

The SDK runs in your middleware; it never talks to a database and never holds the raw request — it
hashes and tokenises on your edge, and only the reduced statement crosses to Heron.

## Development

This repository is the source of truth for Heron's server-free core. Built with `tsup`
(`npm run build` → `dist`, ESM + CJS + types, one bundle per public export path). `npm test` runs the
portability guard and the unit suite; `npm run typecheck` is `tsc --noEmit`.

The Heron app consumes this package back through its subpath exports, so a change to the signed-bytes
functions here ships to the app on publish. To try one against the app before publishing, `npm link`:

```bash
# in this repo
npm run build && npm link
# in the Heron app checkout
npm link @theonaai/heron-sdk
```

## License

Apache-2.0. See [LICENSE](LICENSE).
