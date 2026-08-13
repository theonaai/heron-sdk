---
name: heron-setup
description: Install @theonaai/heron-sdk and wire the Heron guard into this project's agent tool loop end to end — credentials, client, session, contracts, catalog, evidence — without leaking a secret or an argument. Use when asked to "set up Heron", "install the Heron SDK", "guard our tool calls", or "integrate Heron".
---

# /heron-setup — turnkey Heron SDK integration

You are integrating [`@theonaai/heron-sdk`](https://github.com/theonaai/heron-sdk) into the
**current project**: one hook before every agent tool call, one signed statement after it. Work in
this order; each phase ends with something the user can see running. Do not skip the survey — the
right integration shape depends on it.

Two rules override everything else in this file:

1. **Secrets never appear in your output, in code, or in git.** You will handle an Ed25519 seed and
   an API key. They go into the user's secret store or `.env` (git-ignored) and nowhere else —
   never echoed, never logged, never committed, never pasted into a chat reply.
2. **Raw tool arguments never cross to Heron unless a contract deliberately sends them.** The empty
   contract is the safe default. When in doubt, send less; Heron is designed to judge reduced
   statements, not payloads.

## Phase 0 — Survey the project

Establish, by reading the code (Glob/Grep/Read), and confirm with the user only what you cannot
determine yourself:

- **Runtime**: Node ≥ 18 / Bun / Deno / Workers? The SDK needs `fetch`, `AbortController`,
  `setTimeout` and nothing else — no `node:*` built-ins.
- **Package manager**: npm / pnpm / yarn / bun (check lockfiles).
- **The tool loop**: where does a tool call actually begin and end? Find the function that receives
  the model's tool-use request and executes it. This single answer decides the integration shape:
  - Call begins and ends inside one function call → `guard.wrap(tools)` (simplest).
  - Approvals end the run and resume later, workers can be replaced mid-turn, or execution is
    queued → drive the primitives: `guard.decide()` + `guard.report()` / `guard.resolveStepUp()`.
- **Run lifetime**: can one agent run (session) outlive a single process — redeploys, multiple
  replicas, resume-after-approval? If yes, the chain position needs `derivedSessionStore()` or a
  durable `SessionStore` (a Redis key or a DB row per session).
- **Meta-tools**: does one generic tool route many real actions with the target in the args
  (e.g. `*_call_tool` with a `tool_id` argument)? If yes you will need `resolveCall`.
- **Multi-tenancy**: do different customers have different notions of "internal"? If yes,
  `edge.internalDomains` must be a function, never a global list.
- **Existing approval UI**: is there already a human-approval flow? It maps to
  `human_authorized` / `resolveStepUp` / `shownTextHash`.

Write a short summary of these answers before touching code, and get the user's confirmation on the
integration shape (`wrap` vs primitives).

## Phase 1 — Install

```bash
npm i @theonaai/heron-sdk        # or pnpm add / yarn add / bun add
```

Public npm registry; no registry configuration, no token. Only runtime dependencies are
`@noble/hashes` and `@noble/ed25519`.

## Phase 2 — Credentials (five values, all or none)

The client takes exactly five values. A deployment with all five is guarded; with none it is
deliberately unguarded; **four of five is a silent outage of the guard** — code it so that partial
configuration logs an error loudly (see Phase 3).

| Env var | What it is | Where it comes from |
|---|---|---|
| `HERON_BASE_URL` | The Heron deployment's URL | The Heron operator |
| `HERON_API_KEY` | Bearer key, one per environment | Minted by the operator in Settings → API keys; readable once |
| `HERON_VENDOR_KID` | Key id for your signing key | You choose it when registering the public key |
| `HERON_VENDOR_SEED` | Ed25519 seed, base64 — signs your execution evidence | **Generated on your side; never leaves your infrastructure** |
| `HERON_PSEUDONYM_SECRET` | Keys the pseudonyms recipients are tokenised with | Generated on your side; also never sent |

Generate the two local secrets with the SDK's own helpers, writing them straight to `.env` so the
values never appear in the conversation (check `.gitignore` first — see below):

```bash
node -e "
const { generateSeedBase64 } = require('@theonaai/heron-sdk/crypto/ed25519');
require('fs').appendFileSync('.env',
  'HERON_VENDOR_SEED=' + generateSeedBase64() + '\n' +
  'HERON_PSEUDONYM_SECRET=' + generateSeedBase64() + '\n');
console.log('Wrote HERON_VENDOR_SEED and HERON_PSEUDONYM_SECRET to .env');
"
```

Derive the public key from the seed so the user can register it with the Heron operator
(Settings → Vendor keys, or publish a JWKS). The public key is safe to print:

```bash
node --env-file=.env -e "
const { keyPairFromSeed, toBase64Url, publicKeyToJwk } = require('@theonaai/heron-sdk/crypto/ed25519');
const pub = toBase64Url(keyPairFromSeed(process.env.HERON_VENDOR_SEED).publicKey);
console.log(JSON.stringify(publicKeyToJwk(process.env.HERON_VENDOR_KID || 'vendor-key-1', pub), null, 2));
"
```

(`--env-file` needs Node ≥ 20.6; otherwise export the variable in the shell before running.)

Then:

- Put the five variables in the project's secret store, or in `.env` — and **verify `.env` is in
  `.gitignore` before writing to it**. If the project keeps a `.env.example`, add the five names
  there with empty values.
- The public key and the kid are safe to share; the seed and the pseudonym secret are not, and the
  operator never needs them. If asked for the private half, that request is wrong — say so.
- The API key encodes the environment (`hrn_live_<env>_…`); a staging key cannot write into
  production's evidence. Use one key per environment, not one key everywhere.

## Phase 3 — The client, once per process

Create a module (match the project's layout, e.g. `src/heron/client.ts`) that builds **one
`HeronClient` per process, lazily, memoised**. The circuit breaker's state lives on the client — a
client built per call is a breaker that never opens, and per chat it re-pays the retry budget on
every new chat during an outage.

```ts
import { HeronClient } from "@theonaai/heron-sdk";

let cached: HeronClient | null | undefined;

export function heronClient(): HeronClient | null {
  if (cached !== undefined) return cached;

  const values = {
    HERON_BASE_URL: process.env.HERON_BASE_URL,
    HERON_API_KEY: process.env.HERON_API_KEY,
    HERON_VENDOR_KID: process.env.HERON_VENDOR_KID,
    HERON_VENDOR_SEED: process.env.HERON_VENDOR_SEED,
    HERON_PSEUDONYM_SECRET: process.env.HERON_PSEUDONYM_SECRET,
  };
  const present = Object.entries(values).filter(([, v]) => Boolean(v));

  // All five or none. Four-of-five is indistinguishable at runtime from "not
  // part of this deployment", and an action never submitted looks exactly like
  // one that never happened — Heron cannot report the gap. Loud, not thrown:
  // a throw here would fail every tool call over one typo'd variable name.
  if (present.length > 0 && present.length < 5) {
    console.error(
      "Heron is PARTIALLY configured — the guard is inert. Set all five or none:",
      present.map(([k]) => k),
    );
  }
  if (present.length < 5) return (cached = null);

  return (cached = new HeronClient({
    baseUrl: values.HERON_BASE_URL!,
    apiKey: values.HERON_API_KEY!,
    vendorKid: values.HERON_VENDOR_KID!,
    vendorSeed: values.HERON_VENDOR_SEED!,
    pseudonymSecret: values.HERON_PSEUDONYM_SECRET!,
    timeoutMs: 2000, // decide() sits in front of a tool call the agent is waiting on
    breaker: {
      onOpen: (i) => console.error("Heron breaker opened; failing closed until cooldown", i),
      onClose: () => console.info("Heron breaker closed; answers arriving again"),
    },
  }));
}
```

Adapt logging to the project's logger. `null` means "Heron is not part of this deployment" — every
caller treats that as run-unguarded, which is what makes a developer laptop work with no setup.

## Phase 4 — Contracts: start empty, widen deliberately

Create the contract map module (e.g. `src/heron/contracts.ts`):

```ts
import type { ContractMap } from "@theonaai/heron-sdk";

// Empty is the safe default, not an oversight: with no `keep` list, no argument
// value travels at all. Heron judges from the tool name (marked `derived`) and
// from the edge classifier's scalars. Add entries one tool at a time, highest
// blast radius first (money, credentials, outbound sends), once real traffic
// shows what matters.
export const HERON_CONTRACTS: ContractMap = {};
```

When the user is ready to add entries, the shape is:

```ts
"gmail.send": {
  keep: ["subject"],                 // allowlist: only these arg keys travel (redacted)
  anchors: { to: "email", cc: "email", bcc: "email" }, // tokenised — the address never crosses
  signals: ({ args }) => ({ op: "send", recipient_count: 1 }),
},
"ATTIO_*":         { signals: () => ({ data_class: "personal" }) },  // glob over tool names
"server:stripe":   { signals: () => ({ data_class: "financial" }) },  // everything on a server
"provider:composio": { keep: [] },                                    // everything from a provider
```

Rules to state in code comments: resolution is by specificity, never key order; the most specific
`keep` wins whole (a wide key can never widen what leaves the boundary); a wide key declaring a
`data_class` the user has not checked is a signed falsehood — narrow keys you can defend beat one
key that covers everything.

## Phase 5 — The guard in the tool loop

### Shape A — `wrap` (call begins and ends in one function)

```ts
import { openGuardedSession } from "@theonaai/heron-sdk";
import { heronClient } from "./heron/client";
import { HERON_CONTRACTS } from "./heron/contracts";

const heron = heronClient();
if (heron) {
  const guard = await openGuardedSession({
    heron,
    contracts: HERON_CONTRACTS,
    agent: { externalId: agentName, version: agentVersion },
    principal: { type: "human", ref: userId },   // an opaque id, never an email address
    request: firstUserMessageText,               // stays on the edge; only its hash crosses
    sessionExternalId: runId,
    onStepUp: async ({ tool }) => showApprovalUI(tool),
  });
  tools = guard.wrap(tools);
  // ...run the agent...
  await guard.close();
}
```

### Shape B — primitives (approvals end the run, workers are replaced, calls are queued)

```ts
const decision = await guard.decide({ name, args, id: toolCallId });

switch (decision.kind) {
  case "run": {
    const result = await runTool(name, args);
    await guard.report({ ...decision, outcome: "EXECUTED", result });
    break;
  }
  case "step_up":  /* surface an approval; nothing is held open on Heron's side */ break;
  case "modify":   /* decision.transform names a narrowing — submit the narrower call */ break;
  case "defer":    /* decision.pending names context to establish first */ break;
  case "blocked":  /* do not run — including when Heron is unreachable (fail-closed) */ break;
}
```

Wire the rest of the platform's shapes where they exist:

- Approval answered later (any process): `guard.resolveStepUp({ actionId, call, approved, approver,
  shownText })` — pass the text the person actually saw, not a digest.
- Your own UI cleared the call before Heron saw it: `guard.decide(call, { human_authorized: true,
  approver })` — recorded, never lifts a verdict.
- Your own side refused the call (rate limit, budget, viewer permissions):
  `guard.reportUnattempted({ name, args }, { errorCode })` — call it *after* answering the model;
  silence would be published as `MISSING_EXECUTION`.
- A tool call you decided and then dropped: `guard.report({ actionId, decisionId, outcome:
  "NOT_ATTEMPTED" })`.
- Meta-tools: `resolveCall: ({ name, args }) => …` unwraps the envelope — you are the only side
  that knows the shape.
- Timeouts that abandon rather than cancel: `classifyError: (e) => e instanceof TimeoutError ?
  "ABANDONED" : "FAILED"`.

**Never add a fail-open path.** `decide()` answers `blocked` when Heron is unreachable, by design.
Do not wrap it in a try/catch that runs the tool anyway, and do not build a shadow switch of your
own — shadow windows are declared on Heron's side and arrive as `decision.effect === "advisory"`
(the guard surfaces them as `{ kind: "run", rehearsed: true }`; log that flag).

## Phase 6 — State that outlives the process

Only if Phase 0 said runs outlive a process:

- **No storage available**: `store: derivedSessionStore()` and pass each call's own
  `id: toolCallId` to `decide()`. Retries become replays instead of second actions.
- **Durable head** (better for reviewers): keep `derivedSessionStore()`'s `seq` and persist
  `prev_hash` yourself — one key/row per session, e.g. Redis `SET heron:head:<sessionId>
  <recordHash> EX 2592000` in `advance()`, `GET` in `reserve()`. Bound every storage call with a
  short timeout (~250 ms) and degrade to "no predecessor" on a miss — a visible gap in the chain
  beats a stalled agent. Do not add locking: `seq` is derived, and Heron checks the claimed
  predecessor for membership, so honest concurrency is not a finding.

Without either, a resumed run restarts its counter and Heron answers `409`.

## Phase 7 — Tool catalog on boot

Where the process starts (server boot, worker start), publish what the tools *are*:

```ts
await heron.publishToolCatalog([
  { name: "send_email", signals: { op: "send", destination: "external" } },
  { name: "EXECUTE_AGENT", signals: { op: "execute" }, aliases: ["execute_agent"] },
  { name: "some_tool", signals: {} }, // listed with nothing stated ≠ missing from the list
]);
```

- Send it on **every** process start — idempotent by content, replicas dedupe to one statement.
- Only facts constant for the tool; per-call facts belong in `signals`.
- Ever renamed a tool (including letter case)? Add `aliases` — the join is by exact name.
- Reversibility has three values: `true` / `false` / `"costly"` — do not overstate.
- Check `signature_valid` in the response; a `200` stores a bad signature rather than rejecting it.

Build entries from the project's actual tool registry if one exists (enumerate it in code rather
than hand-writing the list, so new tools cannot be silently missing).

## Phase 8 — Optional hardening (offer, don't force)

Present these to the user as a menu; wire the ones they want:

- **Edge classifier options**: `edge: { internalDomains, amountInMinorUnits }` — without
  `internalDomains` the `recipient_external` signal is never claimed. Multi-tenant ⇒ a function
  returning the *customer's* perimeter (`undefined` when unresolvable — an honest `unknown` beats
  a guess).
- **Instructions commitment**: `instructions: () => ({ system, plan })` — a function, read per
  submission, so a mid-session rewrite is what reaches the wire.
- **Shown-text commitment**: `shown_text_hash: heron.shownTextHash(promptText)` on approvals your
  UI collected — binds the approval to what the person actually saw. Keep the text.
- **Credential-shaped durable writes**: `detectCredentialWrite({ target, value })` before saving
  agent memory/instructions/flow — a local warning, nothing crosses.
- **Durable evidence delivery**: `deliver: (send) => queue.add(send)` for an in-process queue; for
  a durable queue, enqueue `{ actionId, decisionId, outcome, resultHash: hashResult(result) }` and
  call `heron.execution(job.data)` from the worker — the raw result never enters the broker.
- **Intent fork** (`intent: { model, slice, ask }` + `session.decideTurn(calls)`): costs one
  completion per turn on a latency-sensitive path; recommend measuring on real traffic first.
- **Task and grant**: `task: { ref: jobId }` links several runs into one job; `grant: { document,
  scope }` records what the run was allowed. Both inert, both committed at the open.

## Phase 9 — Verify

1. `npm run build` / typecheck / lint with the project's own commands — fix everything.
2. Run one real (or scripted) agent turn with the five variables set against the Heron deployment.
   Confirm: session opens, `decide()` answers, evidence lands, and the run appears on the project's
   evidence page.
3. Unset one of the five variables and boot: confirm the loud "PARTIALLY configured" error appears.
4. Unset all five and boot: confirm tools run exactly as before the integration existed.
5. `git status` + `git diff` — confirm no secret value is in the diff (grep the diff for the values'
   prefixes if unsure), `.env` is untracked, `.env.example` carries names only.

Finish by giving the user: the list of files added/changed, the five variables and who supplies
which, what stays in shadow until the operator declares enforcement, and the contract map as the
place where the integration grows next.
