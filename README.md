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
await guard.resolveStepUp({ actionId, call: { name, args }, approved, approver: reviewerId });
```

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

`signals` are typed against `SignalKey` (`SIGNAL_KEYS`): a signal the classifier does not read will
not compile. Each key's `derivable` field says whether Heron can fall back to deriving it from the
tool name (`"full"`/`"partial"`) or whether the fact is pinned to your side (`"none"` — a recipient, a
human's approval). See the trust-boundary notes in the Heron repo.

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

It used to be opt-in, and the first integration reasonably left it off — the only setting anyone
reads about is `internalDomains`, that one genuinely does not generalise across a multi-tenant
platform, and so the whole classifier stayed dark. The result was `magnitude: unknown` on every
action and a bulk rule that never fired, for a reason unrelated to bulk.

It then fills `recipient_count`, `record_count`, `recipient_external` and `amount` from conventional
argument keys (`to` / `cc` / `bcc` / `recipients`, `ids` / `records` / `items`, and for money only
unambiguous names — `amount` / `amount_minor` / `total_amount` / `price`, never a bare `value` or
`total`, which are ordinary words for ordinary arguments),
which you can redirect with `fields`. A tool's own `contract.signals` always wins — the classifier
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
- `openGuardedSession`, `reduce`, `defineContract`, `derivedSessionStore`, `memorySessionStore` — the guard layer.
- `SIGNAL_KEYS`, `SIGNAL_KEY_LIST`, `SignalKey` — the signal vocabulary.
- `classifyAtEdge`, `EdgeClassifierOptions` — the reference classifier over a call's arguments.
- `pseudonymWith`, `replaceAnchors`, `collectAnchors`, `ANCHOR_PATTERNS`, `AnchorType` — edge tokenisation.
- `buildExecutionEvidencePayload`, `ExecutionEvidencePayload` — the statement you sign.

The signed-bytes core is also reachable through stable subpaths, for a consumer that recomputes a
receipt or a chain from the published bundle — this is how the Heron app and `verify-receipt` reuse
the exact functions a vendor signs with:

```ts
import { canonicalize } from "@theonaai/heron-sdk/crypto/jcs";       // RFC 8785
import { hashCanonical, chainRecordHash } from "@theonaai/heron-sdk/crypto/hash";
import { signCanonical, verifyCanonical } from "@theonaai/heron-sdk/crypto/ed25519";
```

Also exported as subpaths: `@theonaai/heron-sdk/contract`, `.../edge-classify`, `.../pseudonym-core`,
`.../statements`, `.../policy/taxonomy`.

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
