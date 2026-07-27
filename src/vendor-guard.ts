import type { SignalKey } from "./contract";
import { hashCanonical } from "./crypto/hash";
import { classifyAtEdge, type EdgeClassifierOptions } from "./edge-classify";
import type { AnchorType } from "./pseudonym-core";
import {
  type BeforeActionResult,
  type ExecutionOutcome,
  HeronClient,
  HeronUnavailableError,
  mayExecute,
} from "./vendor-sdk";

/**
 * The guard layer — the integration loop, made declarative.
 *
 * A vendor writing this by hand re-derives the same ~80 lines: ask before each tool, thread the
 * chain, honour the verdict, run the step-up loop, report what happened. This keeps the one part
 * that cannot be automated — the reduction, which is domain knowledge pinned to the vendor by
 * invariant #6 — as a small declarative *contract per tool*, and owns everything else.
 *
 * Two rules shape it, and both come from what real agent runtimes do rather than from taste:
 *
 *   - **Nothing may live only in this process.** A tool call that needs a human is answered by a
 *     *different* run, often on a different machine; a worker can lose its lease mid-turn. So the
 *     chain position lives behind a `SessionStore`, and the step-up answer is a first-class entry
 *     point (`resolveStepUp`) rather than a callback we hold a stack frame open for.
 *   - **Nothing may be named after one vendor.** The shapes that differ between platforms — how a
 *     call is identified, what an error means, where the after-statement is delivered — are hooks
 *     here, not branches. There is deliberately no mention of any particular tool bus in this file.
 */

/** A signal's value on the wire. */
export type SignalValue = string | number | boolean | null;

/** The signals that stand on their own — everything except the ones that describe an approval. */
type StandaloneSignalKey = Exclude<
  SignalKey,
  "resolves_action" | "human_decision" | "approver" | "human_authorized"
>;

/**
 * A human's involvement, as one statement rather than loose keys — in the two shapes it comes in.
 *
 * **Answering one of Heron's step-ups.** `resolves_action` names it, and without that name the other
 * keys mean nothing: the classifier reads an approval only when it knows which step-up is lifted, so
 * a lone `human_decision` is silently inert. Modelling it as a union makes the incomplete form a
 * compile error at the call site rather than something discovered from a receipt that ignored it —
 * which is how the first integration shipped it, sending a decision and an approver on every
 * human-cleared call and naming no action at all.
 *
 * **An approval your own UI collected before Heron was asked.** That answers no step-up of ours, so
 * it names no action: send `human_authorized: true`. It is recorded and published — "was a person
 * involved, or did the agent do this alone?" is the first question asked of an executed action, and
 * without it the answer is lost — but it never lifts a verdict, because there is no action of ours
 * to check it against and a claim we cannot check must not open a human gate.
 *
 * Sending nothing is of course fine: an ordinary call carries no approval.
 */
export type ApprovalSignals =
  | {
      /** action_id of the STEP_UP this call answers. */
      resolves_action: string;
      /** `"APPROVE"` lifts it; anything else is a decline. Stated, never assumed. */
      human_decision: string;
      /** Opaque token for who decided — never a name (invariant #6). */
      approver?: string | null;
      human_authorized?: never;
    }
  | {
      /** A person cleared this call on your side, before Heron saw it. */
      human_authorized: true;
      /** Opaque token for who decided — never a name (invariant #6). */
      approver?: string | null;
      resolves_action?: never;
      human_decision?: never;
    }
  | {
      resolves_action?: never;
      human_decision?: never;
      approver?: never;
      human_authorized?: never;
    };

/** Scalars a tool asserts. Typed against the ONE vocabulary (src/lib/contract.ts): a signal the
 * classifier does not read will not compile — the same guarantee classify.ts has. */
export type Signals = Partial<Record<StandaloneSignalKey, SignalValue>> & ApprovalSignals;

export interface ReductionCtx<A> {
  args: A;
  /** The user's request, still in full HERE, on the vendor's edge. Compare against it and emit a
   * scalar (e.g. recipient-in-request) — only the scalar crosses, never this text (invariant #6). */
  request: string;
  anchor: (type: AnchorType, value: string) => string;
}

/**
 * How one tool's call is reduced before it crosses the boundary. Declared once, not per call.
 *
 *   - keep    — allowlist of arg keys that travel (redacted). Everything else is dropped, so a field
 *               nobody listed cannot leak: invariant #6 enforced at the SDK layer, not per call.
 *   - anchors — arg keys that carry a recipient/anchor → tokenised on the edge, never sent raw.
 *   - signals — the derivable:"none" facts only the vendor can know (src/lib/contract.ts). A pure
 *               function of the args and the request; scalars out.
 */
export interface ToolContract<A = Record<string, unknown>> {
  keep?: (keyof A & string)[];
  anchors?: Partial<Record<keyof A & string, AnchorType>>;
  signals?: (ctx: ReductionCtx<A>) => Signals;
}

/**
 * Contracts, keyed by what they apply to.
 *
 * A key is one of four things, and the first is the only one that was ever available:
 *
 *   "gmail.send"          one tool, by its exact name
 *   "ATTIO_*"             a glob over tool names — `*` matches any run of characters
 *   "server:attio"        every call this vendor resolved to that server
 *   "provider:composio"   every call this vendor resolved to that provider
 *
 * The three group forms exist because the exact-name form does not survive contact with a platform.
 * The first production window of the first integration carried 228 distinct tools and **not one
 * declared `data_class`** — the dimension that decides `heron.credential.deny`, `heron.money.deny`
 * and `heron.personal.step_up`. Not because the vendor disagreed: because the only way to say it was
 * to write 228 contracts, and nobody writes 228 contracts. The rule Heron could not derive was
 * therefore never asserted by anyone, and 95% of that traffic was allowed on our ignorance rather
 * than on anybody's judgement.
 *
 * **What a group key means, stated plainly, because it is what you are signing.** A signal crosses as
 * `declared` — the vendor's testimony, pinned by `args_hash` — and `declared` *overrides* Heron's own
 * derivation. Writing `"ATTIO_*": { signals: () => ({ data_class: "personal" }) }` asserts a fact
 * about your integration: that every call this matches touches personal data. That is a thing you
 * know and Heron cannot see, which is exactly what the signal vocabulary is for. What it is not is a
 * cheaper way to look well-classified: a wide key that declares a class you have not checked is a
 * signed falsehood, it will silently take calls out of the rules that would have caught them, and
 * `tallySignalSources()` on the evidence page will report it as vendor-asserted. Narrow keys you can
 * defend beat one key that covers everything.
 */
export type ContractMap = Record<string, ToolContract>;

/**
 * Declare one tool's contract against its argument type.
 *
 * `ContractMap` has to be keyed by a plain string — the tools are discovered at runtime — which
 * erases the argument type and leaves `keep` and `signals` unchecked in practice. Writing the
 * contract through this helper puts it back, per tool, without a generic that has to be threaded
 * through the whole map:
 *
 *     const contracts: ContractMap = {
 *       "gmail.send": defineContract<{ to: string; subject: string }>({
 *         keep: ["subject"],            // a typo here is now a compile error
 *         anchors: { to: "email" },
 *         signals: ({ args }) => ({ recipient_count: 1 }),   // args.to is typed
 *       }),
 *     };
 */
export function defineContract<A>(contract: ToolContract<A>): ToolContract {
  return contract as ToolContract;
}

/**
 * How specific a key is. Higher wins, and the order is the only thing that makes the result
 * predictable: two keys that both match must never resolve by which one was typed first, because a
 * signal is a signed statement and "it depended on the object literal's key order" is not something
 * a vendor can answer for.
 */
function specificity(key: string, call: { name: string; provider?: string; server?: string }): number | null {
  if (key === call.name) return 4;
  if (key.startsWith("server:")) return call.server && key.slice(7) === call.server ? 2 : null;
  if (key.startsWith("provider:")) return call.provider && key.slice(9) === call.provider ? 1 : null;
  if (!key.includes("*")) return null;
  const pattern = new RegExp(`^${key.split("*").map(escapeRegExp).join(".*")}$`);
  return pattern.test(call.name) ? 3 : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Literal characters in a glob — the tiebreak between two globs that both match. */
function literals(key: string): number {
  return key.replace(/\*/g, "").length;
}

/**
 * The contract that governs one call, assembled from every key that matches it.
 *
 * Merged **per field**, not per contract, and that choice is the whole design. Letting the most
 * specific match win outright reads well until a vendor adds `"ATTIO_CREATE_RECORD": { keep: [...] }`
 * beside `"ATTIO_*": { signals: … }` and silently loses the group's `data_class` on that one tool —
 * a signal disappearing because an unrelated field was added elsewhere is the kind of failure nobody
 * finds until a reviewer asks why one call in a thousand was classified differently. Merging the
 * *contents* of a field would be worse: `keep` is an allowlist, and a union of allowlists means a
 * wide key can add a field to what leaves the boundary, which is invariant #6 defeated by
 * convenience.
 *
 * So: for each of `keep`, `anchors` and `signals`, the most specific key that defines it wins, whole.
 * Exact name > glob (more literal characters first) > `server:` > `provider:`, and equal specificity
 * is broken by the key's own ordering so the answer never depends on how the map was written.
 *
 * Linear in the number of *contracts*, which is the point of group keys: a platform with 2000 tools
 * writes a dozen of these, not two thousand.
 */
export function resolveContract(
  call: { name: string; provider?: string; server?: string },
  contracts: ContractMap,
): ToolContract {
  const matches: Array<{ contract: ToolContract; rank: number; key: string }> = [];
  for (const [key, contract] of Object.entries(contracts)) {
    const rank = specificity(key, call);
    if (rank !== null) matches.push({ contract, rank, key });
  }
  if (matches.length === 0) return {};
  if (matches.length === 1) return matches[0]!.contract;

  matches.sort(
    (a, b) => b.rank - a.rank || literals(b.key) - literals(a.key) || a.key.localeCompare(b.key),
  );

  return {
    keep: matches.find((m) => m.contract.keep !== undefined)?.contract.keep,
    anchors: matches.find((m) => m.contract.anchors !== undefined)?.contract.anchors,
    signals: matches.find((m) => m.contract.signals !== undefined)?.contract.signals,
  };
}

export interface GuardedTool {
  name: string;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/** The slice of HeronClient the guard drives. HeronClient satisfies it structurally, and a test can
 * substitute a transport that runs the real engine. */
export type GuardClient = Pick<
  HeronClient,
  "anchor" | "openSession" | "beforeAction" | "execution" | "closeSession"
>;

/**
 * Where a session's place in the chain is kept.
 *
 * The default keeps it in memory, which is correct only while a run never outlives one process.
 * That assumption fails in the two most ordinary ways an agent platform works: a call that pauses
 * for a human resumes as a new run, and a worker that loses its lease is replaced. Both restart the
 * counter, and `seq` is unique per session — so what was a silent chain divergence is now a 409
 * from Heron. Implement this over whatever the vendor already has (a row, a Redis key) and it
 * stops being a problem.
 *
 * `reserve` must be atomic per session: an agent that dispatches a fan-out of tool calls will call
 * it concurrently, and two calls must never get the same `seq`. The head they observe *may* be the
 * same — Heron checks the claim for membership, not equality, precisely so honest concurrency is
 * not a finding.
 *
 * A position is reserved before the submission it is for, so a submission that never lands — Heron
 * unreachable, and the call then failed closed — leaves a hole in `seq`. That is deliberate and
 * accurate: the vendor did number an action it did not show Heron. Do not "repair" it by reusing
 * positions, which would make two different actions claim one place in the vendor's own account of
 * its run.
 */
export interface SessionStore {
  /**
   * `callRef` is the vendor's own identifier for the call being submitted, when it has
   * one. A store that keeps a counter can ignore it; `derivedSessionStore()` uses it to
   * need no storage at all.
   */
  reserve(
    sessionExternalId: string,
    callRef?: string,
  ): Promise<{ seq: number; prevHash?: string }>;
  advance(sessionExternalId: string, recordHash: string): Promise<void>;
}

/**
 * A store that stores nothing.
 *
 * The position is *derived* from the call's own identity instead of counted, so it
 * needs no database, no Redis, and no coordination — which matters, because the
 * alternative asks every vendor to own durable storage for state only this SDK reads.
 * A platform that has neither still gets a correct integration.
 *
 * Two things follow, and both are improvements. A retry of the same call submits the
 * same position, so Heron replays the stored decision instead of recording a second
 * action — the one thing a counter can never do. And concurrency needs no lock,
 * because two different calls cannot derive the same number by racing.
 *
 * The cost, stated plainly: `seq` stops being a sequence. Heron requires it to be
 * unique within a session and orders the chain by its own `chain_pos`, so nothing
 * breaks — but a reviewer can no longer read a gap as "the vendor numbered an action
 * it did not show us", because every value is a gap. Pick `memorySessionStore` or your
 * own counter if that reading is worth durable storage to you.
 *
 * Collisions are possible and vanishingly unlikely: the space is 2^31, so a session of
 * a thousand calls collides with probability ~2·10⁻⁴, and a collision costs that one
 * call a 409 — it fails closed and is logged, rather than corrupting anything.
 *
 * `callRef` is required. Without it there is nothing to derive from, and silently
 * falling back to a counter would hand back a position that is wrong in a different way.
 */
export function derivedSessionStore(): SessionStore {
  // Best-effort only: the head is an optional claim Heron checks for membership, so
  // losing it on a restart costs a claim, never a verdict.
  const heads = new Map<string, string>();
  const MAX_TRACKED = 1000;

  return {
    async reserve(sessionExternalId, callRef) {
      if (!callRef) {
        throw new Error(
          "derivedSessionStore needs a call identifier — pass `id` on the call you decide()",
        );
      }
      const digest = hashCanonical(`${sessionExternalId}:${callRef}`);
      const hex = digest.slice(digest.indexOf(":") + 1, digest.indexOf(":") + 9);
      // Masked to 31 bits: Heron stores seq as a signed 32-bit integer.
      const seq = parseInt(hex, 16) & 0x7fffffff;
      return { seq, prevHash: heads.get(sessionExternalId) };
    },

    async advance(sessionExternalId, recordHash) {
      if (heads.size >= MAX_TRACKED && !heads.has(sessionExternalId)) {
        const oldest = heads.keys().next().value;
        if (oldest !== undefined) heads.delete(oldest);
      }
      heads.set(sessionExternalId, recordHash);
    },
  };
}

/** The default. Fine for a run that begins and ends inside one process; nothing else. */
export function memorySessionStore(): SessionStore {
  const state = new Map<string, { seq: number; head?: string }>();
  const of = (id: string) => {
    let s = state.get(id);
    if (!s) state.set(id, (s = { seq: 0 }));
    return s;
  };
  return {
    // Synchronous increment, so concurrent callers get distinct positions: JS runs this to
    // completion before the next one starts.
    async reserve(id) {
      const s = of(id);
      return { seq: s.seq++, prevHash: s.head };
    },
    async advance(id, recordHash) {
      of(id).head = recordHash;
    },
  };
}

/**
 * How this vendor identifies a call, and what its arguments really are.
 *
 * Some platforms route many distinct actions through one generic tool whose real target sits inside
 * the arguments. Heron classifies on the tool name, so left alone every such call would be judged as
 * the same action, and one rule would silently govern hundreds of different operations. Rather than
 * teach Heron about any one platform's envelope, the vendor unwraps it here — it is the only side
 * that knows the shape.
 */
export interface ResolvedCall {
  name: string;
  args: Record<string, unknown>;
  provider?: string;
  server?: string;
}
export type CallResolver = (call: {
  name: string;
  args: Record<string, unknown>;
}) => ResolvedCall;

/**
 * A call as the vendor's runtime knows it. `id` is that runtime's own identifier for
 * this tool call — a tool_call_id, ideally. Supplying it makes a retry a replay rather
 * than a second action, and lets `derivedSessionStore()` work without any storage.
 */
export interface GuardedCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface StepUpRequest {
  actionId: string;
  tool: string;
}

/** The vendor's approval channel. Absent → a STEP_UP stays blocked (fail-closed), which is correct. */
export type StepUpResolver = (
  req: StepUpRequest,
) => Promise<{ approved: boolean; approver: string }>;

export interface GuardOptions {
  heron: GuardClient;
  contracts: ContractMap;
  agent: { externalId: string; name?: string; version?: string };
  principal: { type: "human" | "service"; ref: string };
  /** The user's request, in full — stays on the edge; HeronClient sends only its hash + a redaction. */
  request: string;
  sessionExternalId: string;
  /** Defaults to `memorySessionStore()`. Supply one that outlives the process if your runs do. */
  store?: SessionStore;
  /** Identity and argument normalisation for this vendor's call shape. Defaults to identity. */
  resolveCall?: CallResolver;
  /**
   * In-process convenience for a platform whose approval really is a blocking await. Most are not:
   * if yours ends the run and resumes it later, leave this unset, surface the `step_up` decision,
   * and call `resolveStepUp` when the answer arrives.
   */
  onStepUp?: StepUpResolver;
  /**
   * What a thrown tool means. The default is `FAILED` — the tool told us it did not work.
   *
   * Override it where an error does not mean that. A timeout in most agent runtimes is *abandonment*,
   * not cancellation: the request is still in flight and the side effect may well land. Signing
   * `FAILED` for it would put a claim about the world into a record that can only honestly carry
   * claims about the vendor's own conduct — `ABANDONED` is what that case is for.
   */
  classifyError?: (error: unknown) => Extract<ExecutionOutcome, "FAILED" | "ABANDONED">;
  /**
   * Where the after-statement goes. By default it is sent inline, which puts a network round-trip
   * on the path of a result the agent is already waiting for, and loses the statement outright if
   * the process dies. Hand it to a durable queue instead and both problems go away — an execution
   * that never arrives is a `MISSING_EXECUTION` finding against you.
   */
  deliver?: (send: () => Promise<void>) => void | Promise<void>;
  /** Told about anything the guard swallowed — a failed delivery, an unreachable Heron. */
  onError?: (error: unknown, context: { stage: string; tool?: string }) => void;
  /**
   * The reference edge classifier (src/lib/edge-classify.ts): the arguments of every call are read
   * for the facts only this side can see — how many recipients, how many records — so a tool with no
   * `signals` of its own still asserts its magnitude instead of leaving it `unknown`. Always beaten
   * by a tool's own `contract.signals`.
   *
   * **On by default**, which is a change from it being opt-in. Being opt-in meant the first
   * integration left it off, quite reasonably: the only setting anyone reads about it is
   * `internalDomains`, that one genuinely does not generalise, and so the whole classifier stayed
   * dark — leaving `magnitude` `unknown` on every action and `heron.bulk_external.step_up` dormant
   * for a reason that had nothing to do with it. With no options it emits counts and nothing else,
   * from arguments Heron never sees, so the default costs no disclosure: `amount` needs
   * `amountInMinorUnits` (there is no safe default for a unit) and `recipient_external` needs
   * `internalDomains` (a perimeter only the vendor knows), and neither is guessed.
   *
   * Pass `false` to turn it off.
   */
  edge?: EdgeClassifierOptions | false;
}

/**
 * What Heron answered, in the shape a caller can act on without catching anything.
 *
 * `blocked` covers every reason this call must not run as-is, including Heron being unreachable:
 * a policy gate that throws when it cannot decide has handed the caller an exception where it asked
 * for a verdict, and the overwhelmingly common handling of an exception around a tool call is to log
 * it and carry on — which is the bypass. Fail-closed means the *answer* is "do not run".
 *
 * There is deliberately no fail-open option. The audited way to keep running while Heron cannot
 * decide is Heron's own break-glass, which is signed and published on the evidence page; a switch
 * here would be the same thing, unpublished.
 */
export type GuardDecision =
  | { kind: "run"; actionId: string; decisionId: string; verdict: string }
  | {
      kind: "blocked";
      verdict: string;
      reason: string;
      actionId: string | null;
      decisionId: string | null;
    }
  | { kind: "step_up"; actionId: string; decisionId: string }
  | {
      kind: "modify";
      actionId: string;
      decisionId: string;
      transform: NonNullable<BeforeActionResult["decision"]["transform"]>;
    }
  | {
      kind: "defer";
      actionId: string;
      decisionId: string;
      pending: NonNullable<BeforeActionResult["decision"]["pending"]>;
    };

/** What a wrapped tool returns to the agent when Heron did not clear the action to run. */
export interface BlockedResult {
  heronBlocked: true;
  verdict: string;
  reason: string;
  actionId: string | null;
}

/**
 * Reduce a tool's raw args to what may cross the boundary: an allowlisted, anchor-tokenised object.
 * Pure and exported so it can be unit-tested on its own.
 */
export function reduce(
  args: Record<string, unknown>,
  contract: ToolContract,
  anchor: (type: AnchorType, value: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of contract.keep ?? []) {
    if (key in args) out[key] = args[key];
  }
  // Anchors win over `keep` for the same key: a recipient travels tokenised, never raw.
  for (const [key, type] of Object.entries(contract.anchors ?? {})) {
    const value = args[key];
    if (type && typeof value === "string") out[key] = anchor(type, value);
  }
  return out;
}

export interface GuardedSession {
  /**
   * Ask Heron about one call and get an answer back. The primitive: it never blocks on a human and
   * never throws for an unreachable Heron. Everything else here is built on it.
   */
  /**
   * `signals` carries facts about *this submission* that no contract can derive from the
   * arguments — most usefully, that a human already cleared this call on your side. Without a
   * channel for it, an approval your own UI collected is invisible to Heron: it records an ALLOW
   * that executed and cannot tell an auto-run call from one a person authorised, which is exactly
   * the fact a reviewer is looking for. Merged last, so it beats the contract and the edge classifier.
   */
  decide(call: GuardedCall, signals?: Signals): Promise<GuardDecision>;
  /** File the signed statement of what happened to a call Heron decided on. */
  report(input: {
    actionId: string;
    decisionId: string;
    outcome: ExecutionOutcome;
    result?: unknown;
    /** `hashResult(result)`, when the result cannot travel to whatever files the statement. */
    resultHash?: string | null;
    errorCode?: string | null;
  }): Promise<void>;
  /**
   * Answer a STEP_UP. Submits a *new* action naming the one it resolves — which is the only way an
   * approval enters the record — and returns its decision. Safe to call from a different process
   * than the one that got the STEP_UP: nothing is carried in memory between them.
   */
  resolveStepUp(input: {
    actionId: string;
    call: { name: string; args: Record<string, unknown> };
    approved: boolean;
    approver: string;
  }): Promise<GuardDecision>;
  /** Wrap plain `{ name, run }` tools so they carry the whole loop themselves. */
  wrap(tools: GuardedTool[]): GuardedTool[];
  close(): Promise<unknown>;
}

/**
 * Open a session and return the handle above. `wrap()` is the one-line path; `decide`/`report`/
 * `resolveStepUp` are there for a runtime whose control flow the wrapper cannot fit — which, for
 * anything that pauses for a human, is most of them.
 */
export async function openGuardedSession(opts: GuardOptions): Promise<GuardedSession> {
  const anchor = opts.heron.anchor.bind(opts.heron);
  const store = opts.store ?? memorySessionStore();
  const resolveCall: CallResolver = opts.resolveCall ?? ((c) => ({ name: c.name, args: c.args }));
  const deliver = opts.deliver ?? ((send: () => Promise<void>) => send());

  await opts.heron.openSession({
    externalId: opts.sessionExternalId,
    agent: opts.agent,
    principal: opts.principal,
    originalRequest: opts.request,
  });

  async function submit(
    call: ResolvedCall,
    extra?: Signals,
    callRef?: string,
  ): Promise<BeforeActionResult> {
    const contract = resolveContract(call, opts.contracts);
    const argsRedacted = reduce(call.args, contract, anchor);
    // Precedence, widest to narrowest: the reference classifier reads the arguments, the tool's own
    // contract overrides it (a vendor knows its own call better than a generic library), and the
    // step-up keys come last because they describe *this* submission, not the call.
    const derived = opts.edge === false ? {} : classifyAtEdge(call.args, opts.edge ?? {});
    const base = contract.signals?.({ args: call.args, request: opts.request, anchor }) ?? {};
    // Merged as a plain map, not as `Signals`: the approval keys are a union there, and merging two
    // of its branches is exactly the thing the union forbids at a call site. Each contributor was
    // already type-checked as `Signals` where it was written, which is where the guarantee belongs.
    const signals: Record<string, SignalValue | undefined> = { ...derived, ...base, ...extra };

    const { seq, prevHash } = await store.reserve(opts.sessionExternalId, callRef);
    const before = await opts.heron.beforeAction({
      sessionExternalId: opts.sessionExternalId,
      seq,
      tool: { name: call.name, provider: call.provider, server: call.server },
      args: call.args,
      argsRedacted,
      signals: Object.keys(signals).length > 0 ? signals : undefined,
      prevHash,
      // The runtime's own id is the stable key across the retries it performs, which a
      // per-request value can never be.
      idempotencyKey: callRef ? `action:${opts.sessionExternalId}:${callRef}` : undefined,
    });
    await store.advance(opts.sessionExternalId, before.chain.record_hash);
    return before;
  }

  function interpret(before: BeforeActionResult): GuardDecision {
    const ids = { actionId: before.action_id, decisionId: before.decision.decision_id };
    const verdict = before.decision.verdict;

    if (mayExecute(verdict)) return { kind: "run", verdict, ...ids };
    if (verdict === "STEP_UP") return { kind: "step_up", ...ids };
    // MODIFY and DEFER are answers about what to submit *next*, not about waiting for a person.
    // Collapsing them into the step-up path — which is what treating "not ALLOW and not DENY" as a
    // step-up did — sent a narrowing instruction to a human approver and reported ESCALATED for a
    // call no one had escalated.
    if (verdict === "MODIFY" && before.decision.transform) {
      return { kind: "modify", transform: before.decision.transform, ...ids };
    }
    if (verdict === "DEFER" && before.decision.pending) {
      return { kind: "defer", pending: before.decision.pending, ...ids };
    }
    return { kind: "blocked", verdict, reason: `verdict ${verdict}`, ...ids };
  }

  /**
   * Fail closed, whatever went wrong.
   *
   * Not only for an unreachable Heron: a `SessionStore` that cannot reserve a position, a contract
   * whose `signals` function throws, a bug in this file — every one of them leaves us without a
   * verdict, and every one of them would otherwise surface as an exception at the vendor's tool-call
   * site, where the universal reflex is to log it and carry on. That reflex is the bypass, so the
   * answer here is always an answer. `onError` is how the vendor still sees what happened.
   */
  function unavailable(error: unknown, stage: string, tool?: string): GuardDecision {
    opts.onError?.(error, { stage, tool });
    return {
      kind: "blocked",
      verdict: "UNAVAILABLE",
      reason: error instanceof HeronUnavailableError ? error.message : String(error),
      actionId: null,
      decisionId: null,
    };
  }

  async function decide(call: GuardedCall, signals?: Signals): Promise<GuardDecision> {
    try {
      return interpret(await submit(resolveCall(call), signals, call.id));
    } catch (error) {
      return unavailable(error, "decide", call.name);
    }
  }

  async function report(input: {
    actionId: string;
    decisionId: string;
    outcome: ExecutionOutcome;
    result?: unknown;
    resultHash?: string | null;
    errorCode?: string | null;
  }): Promise<void> {
    const send = async () => {
      try {
        await opts.heron.execution(input);
      } catch (error) {
        // Swallowed on purpose: the statement is evidence, not control flow, and throwing here
        // would fail a tool call that already succeeded. Its absence becomes a MISSING_EXECUTION
        // finding, which is the honest outcome — and the reason `deliver` exists.
        opts.onError?.(error, { stage: "report" });
      }
    };
    await deliver(send);
  }

  async function resolveStepUp(input: {
    actionId: string;
    call: { name: string; args: Record<string, unknown> };
    approved: boolean;
    approver: string;
  }): Promise<GuardDecision> {
    try {
      const before = await submit(resolveCall(input.call), {
        resolves_action: input.actionId,
        human_decision: input.approved ? "APPROVE" : "DENY",
        approver: input.approver,
      });
      return interpret(before);
    } catch (error) {
      return unavailable(error, "resolveStepUp", input.call.name);
    }
  }

  function wrap(tools: GuardedTool[]): GuardedTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      run: async (args: Record<string, unknown>) => {
        let decision = await decide({ name: tool.name, args });

        // The in-process approval path, for the platforms that really do block. A platform that
        // ends the run instead should leave `onStepUp` unset and drive `resolveStepUp` itself.
        if (decision.kind === "step_up") {
          await report({
            actionId: decision.actionId,
            decisionId: decision.decisionId,
            outcome: "ESCALATED",
          });
          if (!opts.onStepUp) {
            return blocked(decision.actionId, "STEP_UP", "no approval channel is configured");
          }
          const { approved, approver } = await opts.onStepUp({
            actionId: decision.actionId,
            tool: tool.name,
          });
          decision = await resolveStepUp({
            actionId: decision.actionId,
            call: { name: tool.name, args },
            approved,
            approver,
          });
        }

        if (decision.kind !== "run") {
          const verdict =
            decision.kind === "blocked"
              ? decision.verdict
              : { step_up: "STEP_UP", modify: "MODIFY", defer: "DEFER" }[decision.kind];

          // Every non-run answer is honoured the same way here — by not running — and each is
          // reported under the outcome that names what we did with it. The code carries the verdict
          // rather than our internal label for it, so the finding reads in Heron's own vocabulary.
          if (decision.actionId && decision.decisionId) {
            await report({
              actionId: decision.actionId,
              decisionId: decision.decisionId,
              outcome: decision.kind === "step_up" ? "ESCALATED" : "BLOCKED",
              errorCode: `heron_${verdict.toLowerCase()}`,
            });
          }
          return blocked(
            decision.actionId,
            verdict,
            decision.kind === "blocked"
              ? decision.reason
              : `${verdict} — honoured by not running; the answer is a new action, not this one`,
          );
        }

        // Only here does the real tool run — after Heron cleared it. The result's hash is signed
        // evidence; HeronClient computes it, the raw result never crosses.
        try {
          const result = await tool.run(args);
          await report({
            actionId: decision.actionId,
            decisionId: decision.decisionId,
            outcome: "EXECUTED",
            result,
          });
          return result;
        } catch (error) {
          // A tool that throws still ran, and an action Heron allowed with no execution statement
          // against it is a MISSING_EXECUTION finding — the vendor looking like it hid something,
          // for the most ordinary event in the system.
          await report({
            actionId: decision.actionId,
            decisionId: decision.decisionId,
            outcome: opts.classifyError?.(error) ?? "FAILED",
            errorCode: errorCode(error),
          });
          // Rethrown: the guard reports, it does not change how the vendor's own runtime handles a
          // failing tool.
          throw error;
        }
      },
    }));
  }

  return {
    decide,
    report,
    resolveStepUp,
    wrap,
    close: () => opts.heron.closeSession(opts.sessionExternalId),
  };
}

function blocked(actionId: string | null, verdict: string, reason: string): BlockedResult {
  return { heronBlocked: true, verdict, reason, actionId };
}

/** A short, non-sensitive label for why a tool threw. Never the message: it can carry arguments. */
function errorCode(error: unknown): string {
  if (error instanceof Error && error.name && error.name !== "Error") return error.name;
  return "tool_error";
}
