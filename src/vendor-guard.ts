import type { SignalKey } from "./contract";
import { hashCanonical } from "./crypto/hash";
import type { SessionGrant, SessionTask } from "./delegation";
import { classifyAtEdge, type EdgeClassifierOptions } from "./edge-classify";
import { INSTRUCTIONS_SIGNAL, instructionsHash } from "./instructions";
import {
  type IntentOptions,
  type IntentSignals,
  buildIntentQuestion,
  intentSignals,
  parseIntentAnswer,
  stripMeasured,
} from "./policy/intent";
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

/**
 * The signals that stand on their own — everything except the two statements that only mean
 * anything whole: an approval, and the provenance of a model's claim.
 */
type StandaloneSignalKey = Exclude<
  SignalKey,
  | "resolves_action"
  | "human_decision"
  | "approver"
  | "human_authorized"
  | "inferred"
  | "inference_model"
  | "inference_prompt_hash"
  | "inference_slice"
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

/**
 * Which of the signals sent beside this one are a model's word rather than a measurement — and who
 * the model was.
 *
 * Modelled as a union for the same reason `ApprovalSignals` is: the four keys are one statement, and
 * the incomplete form is worse than silence. A `inferred: "data_class"` with no model named is a
 * verdict a reviewer can count and cannot question; a model named with no dimensions listed is
 * provenance for nothing. Both are a compile error here rather than a 400 discovered from a receipt.
 *
 * Sending nothing is the normal case: an ordinary call carries no model claim, and until the vendor's
 * fork ships, every call is an ordinary call.
 */
export type InferenceSignals =
  | {
      /** The dimensions the model supplied — build it with `formatInferredDimensions`. */
      inferred: string;
      /** The model that answered, as you name it. */
      inference_model: string;
      /** Hash of the judging prompt you put to it. */
      inference_prompt_hash: string;
      /** How much of the conversation it saw — a label, never the text (invariant #6). */
      inference_slice: string;
    }
  | {
      inferred?: never;
      inference_model?: never;
      inference_prompt_hash?: never;
      inference_slice?: never;
    };

/**
 * The commitment to the agent's governing text (src/instructions.ts) — the one key here that is
 * *not* part of the classifier's vocabulary.
 *
 * It sits outside `SIGNAL_KEYS` on purpose: nothing may turn a verdict on it, and the whole worth of
 * the scalar is that it is inert. But it does travel in `signals` — which buys chain coverage for
 * free, since `signals_hash` is in the chained record and a commitment therefore cannot be restated
 * later — so it needs a slot here, or the one thing the type system would have caught (a typo in the
 * key) becomes a commitment silently sent to nobody.
 *
 * Build it with `instructionsHash()`. A digest in any other shape is a 400, because a value that
 * cannot be compared reads as a change on every action.
 */
export interface InstructionSignals {
  instructions_hash?: string;
}

/**
 * The commitment to what a human was shown before they approved (src/shown-text.ts) — the second key
 * here that is outside the classifier's vocabulary, and outside it for the same reason.
 *
 * It belongs on the action carrying the answer, and `resolveStepUp` fills it for you from the text:
 * hand it what you rendered and the digest is keyed with your own secret, so the field below is for
 * the paths that build their own signals — an approval your UI collected before Heron was asked, most
 * of all, since that is where a confirmation prompt of your own design lives.
 *
 * Build it with `HeronClient.shownTextHash()`. A digest in any other shape is a 400: this one is never
 * compared with anything of Heron's, so a value nobody can reproduce later binds you to nothing while
 * still publishing the approval as bound to its prompt.
 */
export interface ShownTextSignals {
  shown_text_hash?: string;
}

/** Scalars a tool asserts. Typed against the ONE vocabulary (src/lib/contract.ts): a signal the
 * classifier does not read will not compile — the same guarantee classify.ts has. */
export type Signals = Partial<Record<StandaloneSignalKey, SignalValue>> &
  ApprovalSignals &
  InferenceSignals &
  InstructionSignals &
  ShownTextSignals;

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
 *   - anchors — arg keys that carry a recipient/anchor → tokenised on the edge, never sent raw. A
 *               key holding a *list* of them (`cc`, `bcc`, `extra_recipients`) is tokenised
 *               entry by entry, which is the shape most send APIs actually use.
 *   - signals — the derivable:"none" facts only the vendor can know (src/lib/contract.ts). A pure
 *               function of the args and the request; scalars out.
 *   - resource — the stable id of the object acted on, which is the only thing that can link two
 *               sessions through the record they both touched. Opaque ids only.
 */
export interface ToolContract<A = Record<string, unknown>> {
  keep?: (keyof A & string)[];
  anchors?: Partial<Record<keyof A & string, AnchorType>>;
  signals?: (ctx: ReductionCtx<A>) => Signals;
  /**
   * The stable id of the thing this call acts on — a thread id, an issue key, a document id.
   *
   * It is the only key that can link two sessions through a shared object: *this run and that one
   * touched the same record* is a question nothing else in the wire can answer, and a reviewer
   * asking "what else happened to this document" has no other handle. Heron hashes it into the chain
   * record, so it cannot be restated later.
   *
   * **An opaque id, never an address or a title.** It is stored and published as given, and unlike
   * `principal.ref` nothing at the door refuses one that looks like an email — so a calendar
   * invitation keyed by attendee, or a document keyed by its name, would put exactly the thing
   * anchors exist to tokenise on the wire in the clear. If the natural handle for a resource is not
   * opaque, return nothing rather than a hash of your own: an unkeyed digest of a short title is not
   * hiding it.
   *
   * Returning `undefined` is the ordinary case — most calls act on no nameable resource.
   */
  resource?: (ctx: ReductionCtx<A>) => string | undefined;
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
function specificity(
  key: string,
  call: { name: string; provider?: string; server?: string },
): number | null {
  if (key === call.name) return 4;
  if (key.startsWith("server:"))
    return call.server && key.slice(7) === call.server ? 2 : null;
  if (key.startsWith("provider:"))
    return call.provider && key.slice(9) === call.provider ? 1 : null;
  if (!key.includes("*")) return null;
  const pattern = new RegExp(
    `^${key.split("*").map(escapeRegExp).join(".*")}$`,
  );
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
  const matches: Array<{ contract: ToolContract; rank: number; key: string }> =
    [];
  for (const [key, contract] of Object.entries(contracts)) {
    const rank = specificity(key, call);
    if (rank !== null) matches.push({ contract, rank, key });
  }
  if (matches.length === 0) return {};
  if (matches.length === 1) return matches[0]!.contract;

  matches.sort(
    (a, b) =>
      b.rank - a.rank ||
      literals(b.key) - literals(a.key) ||
      a.key.localeCompare(b.key),
  );

  return {
    keep: matches.find((m) => m.contract.keep !== undefined)?.contract.keep,
    anchors: matches.find((m) => m.contract.anchors !== undefined)?.contract
      .anchors,
    signals: matches.find((m) => m.contract.signals !== undefined)?.contract
      .signals,
    resource: matches.find((m) => m.contract.resource !== undefined)?.contract
      .resource,
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
  | "anchor"
  | "shownTextHash"
  | "openSession"
  | "beforeAction"
  | "execution"
  | "closeSession"
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
      const hex = digest.slice(
        digest.indexOf(":") + 1,
        digest.indexOf(":") + 9,
      );
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

/**
 * The vendor's approval channel. Absent → a STEP_UP stays blocked (fail-closed), which is correct.
 *
 * `shownText` is optional and is the text this channel put in front of the person — returned rather
 * than asked for, because this function is the only place in the loop that knows it. It is digested
 * with the client's own key before anything crosses (src/shown-text.ts); nothing here sends a prompt.
 */
export type StepUpResolver = (
  req: StepUpRequest,
) => Promise<{ approved: boolean; approver: string; shownText?: string }>;

export interface GuardOptions {
  heron: GuardClient;
  contracts: ContractMap;
  agent: { externalId: string; name?: string; version?: string };
  principal: { type: "human" | "service"; ref: string };
  /** The user's request, in full — stays on the edge; HeronClient sends only its hash + a redaction. */
  request: string;
  sessionExternalId: string;
  /**
   * The job this run belongs to, and the run that spawned it (src/delegation.ts). Passed straight
   * through to the open: it is a fact about the run, so it is stated once, where the run begins.
   */
  task?: SessionTask;
  /**
   * What this run was allowed to do (src/delegation.ts).
   *
   * Also stated once, at the open, and deliberately not per call: a delegation restated on every call
   * is one that can differ between two calls of the same run, and no reading of that disagreement is
   * honest. If the authority genuinely changes mid-flight, that is a new run.
   */
  grant?: SessionGrant;
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
  classifyError?: (
    error: unknown,
  ) => Extract<ExecutionOutcome, "FAILED" | "ABANDONED">;
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
   * The agent's governing text, read once per submission and committed as `instructions_hash`
   * (src/instructions.ts).
   *
   * A function rather than a value, because the slot is not constant: a runtime rewrites the system
   * prompt and the plan block mid-session — compaction does it on most turns — and that rewrite is
   * the entire thing the commitment exists to make visible. A value captured when the session opened
   * would commit to the text as it was and publish *unchanged* through every rewrite, which is worse
   * than sending nothing: it is a false statement about your own agent, in a record nobody can
   * correct afterwards.
   *
   * Set it and every call commits, which is the coverage rule the digest is published under — send
   * it on every action or accept that the figure says you did not. Without it the key is simply
   * absent, and you can still pass `instructions_hash` yourself in a call's `signals`; an explicit
   * one wins, since it is the narrower statement about that submission.
   *
   * It cannot move a verdict — the key is outside the classifier's vocabulary by construction, which
   * is what stops *not setting this* from being a way to steer one.
   *
   * A throw here is swallowed and reported to `onError`, never propagated: a diagnostic that has not
   * been asked to gate anything must not be able to fail a tool call the agent is waiting on.
   */
  instructions?: () => { system: string; plan?: string | null };
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
  /**
   * The fork (src/policy/intent.ts): before a group of tool calls, fork the live session — same
   * agent, same model — and ask it what it is about to do. The answer crosses as an `inferred`
   * claim, marked as testimony, and Heron reads it only where its own pass came back `unknown`.
   *
   * Off unless set, and it only ever runs from `decideTurn()`. Both are deliberate. Off, because
   * this spends the vendor's tokens on the vendor's bill and nobody should discover that from an
   * invoice. And from `decideTurn` alone, because the unit is a **model turn**, not a call: a fork
   * per call would multiply the cost by the fan-out and ask the same question of the same context
   * several times over. `decide()` never asks, which is also how you skip a turn that is not worth
   * asking about — a page of reads, most obviously.
   */
  intent?: IntentOptions;
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
  | {
      kind: "run";
      actionId: string;
      decisionId: string;
      verdict: string;
      /**
       * Set when the call runs because the project is in a declared shadow window
       * (`decision.effect: "advisory"`) and *not* because the verdict allowed it. The call goes
       * ahead and the execution is published as a rehearsal — but a `DENY` was still recorded
       * against it, so this is the flag worth logging: it is the list of things that would have
       * stopped once the vendor declares enforcement.
       */
      rehearsed?: true;
    }
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

/**
 * What `reportUnattempted` filed, and what Heron would have said about it.
 *
 * Deliberately not a `GuardDecision`. That type is an answer to *may I run this*, and every branch
 * of it is something a caller acts on — handing one back for a call that has already been refused
 * is an invitation to un-refuse it on a verdict that was never asked for. This one is a receipt:
 * two ids you can put in your own logs, and a verdict that is a measurement, not a permission.
 */
export interface UnattemptedReport {
  /** The action Heron linked into the session chain, or null if it could not be reached. */
  actionId: string | null;
  decisionId: string | null;
  /**
   * The verdict Heron returned for a call that was never made — `null` if it did not answer.
   *
   * Read it as *what our policy would have said*, never as clearance. It is worth logging for one
   * reason: an `ALLOW` here means your own limit stopped something the published policy permits, and
   * a `DENY` means the two agree — which is the only cheap way to see the two rulebooks diverging.
   */
  wouldHaveBeen: string | null;
}

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
    if (!type) continue;
    const value = args[key];
    if (typeof value === "string") {
      out[key] = anchor(type, value);
      continue;
    }
    // A list of recipients is the ordinary shape, not an exotic one: `cc`, `bcc` and
    // `extra_recipients` on an email are arrays, and so is every "send to these people" API worth
    // guarding. Handling only strings dropped them silently — not raw (nothing crossed, so invariant
    // #6 was never at risk), but *invisibly*: a message to one address in `to` and two hundred in
    // `bcc` reached Heron as a single-recipient send, and the recipient comparison it exists for saw
    // one name where the call named two hundred and one. Heron's own reader walks arrays already
    // (`collectArgAnchors`), so the tokens land the moment they are sent.
    //
    // Non-string entries are dropped rather than passed through. An array of `{email}` objects is a
    // shape this cannot tokenise, and copying it verbatim to preserve the length would put raw
    // values on the wire under a key the contract promised was anchored — the one direction a
    // reduction may never fail in. The count is not lost by it either: the edge classifier reads the
    // *raw* arguments, so `recipient_count` is computed before any of this.
    if (Array.isArray(value)) {
      out[key] = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => anchor(type, item));
    }
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
  /**
   * Decide every call of one model turn, asking the fork once for the group (`GuardOptions.intent`).
   *
   * Returns one decision per call, in the order given. With no `intent` configured it is simply
   * `decide()` over the group — which is still the entry point to reach for, because the turn is the
   * unit the fork is priced in and adding it later is then a config change rather than a rewrite.
   */
  decideTurn(calls: GuardedCall[], signals?: Signals): Promise<GuardDecision[]>;
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
   * Record a call your side refused **before** the guard was ever asked, or gave up on afterwards.
   *
   * Your own limits already stop calls: a rate limit, a budget, a tool a viewer may not run, an
   * agent that changed its mind between choosing the tool and reaching it. Today those calls exist
   * in your logs and nowhere else — Heron has no action, no verdict and nothing to pair, so the
   * safest thing your platform does is the one thing its record cannot show.
   *
   * This submits the action the way `decide()` would (same contract, same reduction, same edge
   * classifier — no argument crosses that would not have crossed anyway) and immediately files a
   * `NOT_ATTEMPTED` statement against it. What you get is a row that says *the agent asked for this,
   * and it did not happen* — plus, in the return value, what Heron would have answered, which is how
   * you find out whether your own limit is stricter or looser than the policy you publish.
   *
   * **Nothing is gated on it and nothing throws.** The call is already not happening, so an
   * unreachable Heron costs you the row and never a run — the opposite of `decide()`, which fails
   * closed because something is waiting on its answer. Call it after you have answered the model,
   * not in front of it: it is two round trips, and the second one goes through `deliver`.
   */
  reportUnattempted(
    call: GuardedCall,
    extra?: {
      /**
       * A short label for why, in your own vocabulary — `rate_limited`, `budget_exhausted`,
       * `viewer_not_permitted`. Free prose, never read by a rule: Heron judges its own record, and a
       * verdict that turned on a string the audited party chooses would be a verdict it writes.
       */
      errorCode?: string;
      /** Facts about this submission, exactly as `decide()` takes them. */
      signals?: Signals;
    },
  ): Promise<UnattemptedReport>;
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
    /**
     * The text your confirmation UI actually rendered to the person who answered.
     *
     * The **text**, not a digest: the digest is computed here with the key the client already holds
     * (`HeronClient.shownTextHash`), so the one thing that makes it safe to publish a commitment at
     * all cannot be forgotten at a call site. The text does not cross — invariant #6 is not bent for
     * this, and Heron never sees a byte of it.
     *
     * Omit it and the approval is recorded exactly as before, and published as an answer nothing
     * says the grounds for. That is the honest reading, and it is why this is worth two lines: an
     * approval given to a misleading prompt and one given to an accurate prompt are otherwise the
     * same record.
     */
    shownText?: string;
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
export async function openGuardedSession(
  opts: GuardOptions,
): Promise<GuardedSession> {
  const anchor = opts.heron.anchor.bind(opts.heron);
  const store = opts.store ?? memorySessionStore();
  const resolveCall: CallResolver =
    opts.resolveCall ?? ((c) => ({ name: c.name, args: c.args }));
  const deliver = opts.deliver ?? ((send: () => Promise<void>) => send());

  const opened = await opts.heron.openSession({
    externalId: opts.sessionExternalId,
    agent: opts.agent,
    principal: opts.principal,
    originalRequest: opts.request,
    task: opts.task,
    grant: opts.grant,
  });
  // The open answers with this session's genesis hash, and seeding the store with it is what makes
  // the *first* action claim a link at all. Two things follow, and both were wrong without it.
  // A vendor that drops its first action left nothing pointing at genesis, so the hole was
  // invisible to Heron. And the head is a per-session value kept in a process-wide map, only ever
  // written by `advance()` — so a session that opened after another one in the same process
  // inherited its predecessor's last `record_hash` and claimed it, which reads on the evidence page
  // as a BROKEN_CHAIN indistinguishable from tampering. Writing genesis here resets it, every time.
  await store.advance(opts.sessionExternalId, opened.head_hash);

  /**
   * The commitment for this submission, or nothing.
   *
   * Placed *under* every other contributor in the merge: `instructions_hash` is a fact about the
   * session rather than about this call, so a caller passing one explicitly is making the narrower
   * statement and wins. Nothing else writes the key, so in practice this is a merge with an empty
   * map — the ordering is there so it stays correct when that stops being true.
   *
   * Swallows a throw from the vendor's callback. The alternative is failing a tool call because a
   * diagnostic could not read a string, which trades the thing the guard is for against the thing it
   * reports on.
   */
  function committedInstructions(tool: string): Record<string, SignalValue> {
    if (!opts.instructions) return {};
    try {
      return { [INSTRUCTIONS_SIGNAL]: instructionsHash(opts.instructions()) };
    } catch (error) {
      opts.onError?.(error, { stage: "instructions", tool });
      return {};
    }
  }

  async function submit(
    call: ResolvedCall,
    extra?: Signals,
    callRef?: string,
    claim?: IntentSignals,
  ): Promise<BeforeActionResult> {
    const contract = resolveContract(call, opts.contracts);
    const argsRedacted = reduce(call.args, contract, anchor);
    // Precedence, widest to narrowest: the reference classifier reads the arguments, the tool's own
    // contract overrides it (a vendor knows its own call better than a generic library), and the
    // step-up keys come last because they describe *this* submission, not the call.
    const derived =
      opts.edge === false
        ? {}
        : classifyAtEdge(call.args, opts.edge ?? {}, {
            tool: call.name,
            provider: call.provider,
            server: call.server,
            principal: opts.principal,
            sessionExternalId: opts.sessionExternalId,
          });
    const base =
      contract.signals?.({ args: call.args, request: opts.request, anchor }) ??
      {};
    // Merged as a plain map, not as `Signals`: the approval keys are a union there, and merging two
    // of its branches is exactly the thing the union forbids at a call site. Each contributor was
    // already type-checked as `Signals` where it was written, which is where the guarantee belongs.
    const measured: Record<string, SignalValue | undefined> = {
      ...committedInstructions(call.name),
      ...derived,
      ...base,
      ...extra,
    };

    // The model's claim goes UNDER every measurement, and only for dimensions no measurement spoke
    // to. It has to be this way round because a claim travels under the same key a measurement does:
    // merged on top it would not lose the argument, it would *replace* the measurement in transit and
    // mark the survivor as a model's word — leaving Heron one value, labelled `inferred`, with no way
    // to learn that this side had measured something else. `stripMeasured` re-derives the marking from
    // what survives, so the witness never outlives the claims it was provenance for.
    const signals: Record<string, SignalValue | undefined> = claim
      ? { ...stripMeasured(claim, measured), ...measured }
      : measured;

    const { seq, prevHash } = await store.reserve(
      opts.sessionExternalId,
      callRef,
    );
    const before = await opts.heron.beforeAction({
      sessionExternalId: opts.sessionExternalId,
      seq,
      tool: { name: call.name, provider: call.provider, server: call.server },
      args: call.args,
      argsRedacted,
      signals: Object.keys(signals).length > 0 ? signals : undefined,
      // The wire has carried this since v1 and the guard never filled it, so every vendor using the
      // documented path reported `resource_ref` on 0% of calls and read as having declined to send
      // it. Same reduction context as `signals`, so a contract states it beside everything else it
      // says about the call.
      resourceRef: contract.resource?.({
        args: call.args,
        request: opts.request,
        anchor,
      }),
      prevHash,
      // The runtime's own id is the stable key across the retries it performs, which a
      // per-request value can never be.
      idempotencyKey: callRef
        ? `action:${opts.sessionExternalId}:${callRef}`
        : undefined,
    });
    await store.advance(opts.sessionExternalId, before.chain.record_hash);
    return before;
  }

  function interpret(before: BeforeActionResult): GuardDecision {
    const ids = {
      actionId: before.action_id,
      decisionId: before.decision.decision_id,
    };
    const verdict = before.decision.verdict;
    const effect = before.decision.effect;

    if (mayExecute(verdict)) return { kind: "run", verdict, ...ids };
    // Everything below this line is a verdict that does not run — unless Heron has told us, in this
    // decision, that the project is rehearsing. Read from the answer rather than from a setting of
    // ours: a runtime that decided its own posture would report shadow truthfully on every call and
    // there would be no breach to find, which is why the declaration lives on Heron's side and
    // arrives here signed. An unreachable Heron says nothing at all, so it still fails closed.
    if (effect === "advisory")
      return { kind: "run", verdict, rehearsed: true, ...ids };
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
  function unavailable(
    error: unknown,
    stage: string,
    tool?: string,
  ): GuardDecision {
    opts.onError?.(error, { stage, tool });
    return {
      kind: "blocked",
      verdict: "UNAVAILABLE",
      reason:
        error instanceof HeronUnavailableError ? error.message : String(error),
      actionId: null,
      decisionId: null,
    };
  }

  async function decide(
    call: GuardedCall,
    signals?: Signals,
    claim?: IntentSignals,
  ): Promise<GuardDecision> {
    try {
      return interpret(
        await submit(resolveCall(call), signals, call.id, claim),
      );
    } catch (error) {
      return unavailable(error, "decide", call.name);
    }
  }

  /**
   * Ask the fork once for the whole turn, and hand each call the claim about itself.
   *
   * Everything here fails to *silence* rather than to an error: a fork that throws, times out,
   * declines, or answers something unparseable costs the turn its claims and nothing else, and the
   * calls are decided exactly as they would have been without it. That direction is not politeness —
   * a claim only ever fills a dimension nothing else answered, so its absence leaves the dimension
   * `unknown` and the friction in place. An intent asker that could take a verdict down would have
   * made the safety feature a new outage.
   */
  async function askIntent(
    calls: GuardedCall[],
  ): Promise<Map<string, IntentSignals>> {
    const claims = new Map<string, IntentSignals>();
    if (!opts.intent || calls.length === 0) return claims;

    // The ref is the runtime's own call id where there is one, so the model's answer is keyed by the
    // same identity the rest of the loop uses. The positional fallback is scoped to this question and
    // never leaves it.
    const refs = calls.map((call, index) => call.id ?? `call_${index + 1}`);
    const question = buildIntentQuestion(
      calls.map((call, index) => ({ ref: refs[index]!, name: call.name })),
    );

    try {
      const answer = await opts.intent.ask(question);
      for (const parsed of parseIntentAnswer(answer, refs)) {
        const signals = intentSignals(parsed, opts.intent);
        if (Object.keys(signals).length > 0) claims.set(parsed.ref, signals);
      }
    } catch (error) {
      opts.onError?.(error, { stage: "intent" });
    }
    return claims;
  }

  /**
   * Decide a whole model turn: one question to the fork, then the calls, each carrying the claim
   * about itself.
   *
   * The turn is the unit because that is what the fork is cheap on — the prefix is already cached, so
   * one completion covers every call the model just decided to make. Use it wherever your runtime
   * knows its turn boundary; use `decide()` for a single call, or for a turn you have decided is not
   * worth asking about.
   *
   * The calls are submitted concurrently, as an agent runtime dispatches them. Heron links them in
   * arrival order under its own chain position, so their order here is not load-bearing — and the
   * decisions come back in the order the calls were given, whatever order they landed in.
   */
  async function decideTurn(
    calls: GuardedCall[],
    signals?: Signals,
  ): Promise<GuardDecision[]> {
    const claims = await askIntent(calls);
    return Promise.all(
      calls.map((call, index) =>
        decide(call, signals, claims.get(call.id ?? `call_${index + 1}`)),
      ),
    );
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

  async function reportUnattempted(
    call: GuardedCall,
    extra?: { errorCode?: string; signals?: Signals },
  ): Promise<UnattemptedReport> {
    try {
      const before = await submit(resolveCall(call), extra?.signals, call.id);
      await report({
        actionId: before.action_id,
        decisionId: before.decision.decision_id,
        outcome: "NOT_ATTEMPTED",
        errorCode: extra?.errorCode ?? null,
      });
      return {
        actionId: before.action_id,
        decisionId: before.decision.decision_id,
        wouldHaveBeen: before.decision.verdict,
      };
    } catch (error) {
      // Reported, not thrown, and deliberately not `unavailable()`: that helper answers the
      // question "may this run", and there is no such question here — the call was already refused
      // by the caller. An unreachable Heron costs the record one row, which is exactly what happens
      // today for every one of these calls, so the failure mode is the status quo rather than a new
      // one. Failing closed here could only mean breaking a refusal path that was working.
      opts.onError?.(error, { stage: "reportUnattempted", tool: call.name });
      return { actionId: null, decisionId: null, wouldHaveBeen: null };
    }
  }

  async function resolveStepUp(input: {
    actionId: string;
    call: { name: string; args: Record<string, unknown> };
    approved: boolean;
    approver: string;
    shownText?: string;
  }): Promise<GuardDecision> {
    try {
      const before = await submit(resolveCall(input.call), {
        resolves_action: input.actionId,
        human_decision: input.approved ? "APPROVE" : "DENY",
        approver: input.approver,
        // Digested here, with the client's own key, so the vendor passes the prompt and never the
        // hash. Spread rather than set to `undefined`: an explicit `shown_text_hash: undefined`
        // would still be a key in the object, and the signals object is hashed into the chain
        // record — a key that is present and empty is not the same statement as one that is absent.
        ...(input.shownText === undefined
          ? {}
          : { shown_text_hash: opts.heron.shownTextHash(input.shownText) }),
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
            return blocked(
              decision.actionId,
              "STEP_UP",
              "no approval channel is configured",
            );
          }
          const { approved, approver, shownText } = await opts.onStepUp({
            actionId: decision.actionId,
            tool: tool.name,
          });
          decision = await resolveStepUp({
            actionId: decision.actionId,
            call: { name: tool.name, args },
            approved,
            approver,
            shownText,
          });
        }

        if (decision.kind !== "run") {
          const verdict =
            decision.kind === "blocked"
              ? decision.verdict
              : { step_up: "STEP_UP", modify: "MODIFY", defer: "DEFER" }[
                  decision.kind
                ];

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
    decideTurn,
    report,
    reportUnattempted,
    resolveStepUp,
    wrap,
    close: () => opts.heron.closeSession(opts.sessionExternalId),
  };
}

function blocked(
  actionId: string | null,
  verdict: string,
  reason: string,
): BlockedResult {
  return { heronBlocked: true, verdict, reason, actionId };
}

/** A short, non-sensitive label for why a tool threw. Never the message: it can carry arguments. */
function errorCode(error: unknown): string {
  if (error instanceof Error && error.name && error.name !== "Error")
    return error.name;
  return "tool_error";
}
