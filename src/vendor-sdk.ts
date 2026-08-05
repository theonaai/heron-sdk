import type { SignalKey } from "./contract";
import { keyPairFromSeed, signCanonical } from "./crypto/ed25519";
import { hashCanonical } from "./crypto/hash";
import { type AnchorType, collectAnchors, pseudonymWith } from "./pseudonym-core";
import { shownTextHash } from "./shown-text";
import { buildExecutionEvidencePayload } from "./statements";
import { type CatalogEntry, buildToolCatalog, catalogHash } from "./tool-catalog";

/**
 * The vendor holds its own pseudonym key, so it needs no per-org separation: the key
 * already is the separation.
 */
const VENDOR_SCOPE = "vendor";

/**
 * The vendor side of the integration (§12) — what lives in the vendor's middleware.
 *
 * One hook before the tool call, one signed statement after it. Heron enforces — the caller must
 * honour the verdict it returns (execute only on ALLOW; a human clears STEP_UP; DENY does not run)
 * and report the outcome either way (`BLOCKED` when it honoured a DENY). Heron never sees the
 * private key.
 */

export interface HeronClientOptions {
  baseUrl: string;
  apiKey: string;
  vendorKid: string;
  /** base64 Ed25519 seed. Stays on the vendor's side, always. */
  vendorSeed: string;
  /**
   * Keys the pseudonyms `anchor()` produces. Also stays on the vendor's side: with it,
   * recipients never leave the vendor's network in any recoverable form, and Heron
   * cannot recover them either.
   */
  pseudonymSecret: string;
  /**
   * How long any one request may take before it is abandoned, in ms.
   *
   * This is not a tuning knob, it is the other half of the latency contract. Heron sheds a policy
   * load that blows its own budget and answers a signed `policy_timeout` DENY — "slow is down" —
   * and a client with no deadline turns that discipline into a hung agent, because the one thing a
   * blocked `before_action` can do to a vendor is stop its run forever. Default 2000.
   */
  timeoutMs?: number;
  /**
   * How many times a *retryable* failure is retried (network, 429, 5xx). Retries are safe because
   * every request carries a stable idempotency key: Heron replays the stored decision rather than
   * judging the action twice. Default 2 (three attempts).
   */
  retries?: number;
  /**
   * What to do once Heron has stopped answering entirely — see `CircuitBreakerOptions`. On by
   * default, because the alternative is every integration writing it again and the first one
   * discovering it needs it in production. `false` disables it.
   */
  breaker?: CircuitBreakerOptions | false;
  /** Injectable for tests and for runtimes with their own instrumented fetch. */
  fetch?: typeof fetch;
}

export interface BeforeActionResult {
  action_id: string;
  decision: {
    decision_id: string;
    verdict: string;
    engine: string;
    /** On a MODIFY: the narrowing the edge must apply, then re-submit as a new action. */
    transform?: { note: string; narrow_destination_to?: string; reduce_magnitude_to?: string };
    /** On a DEFER: the prior context the edge must establish before re-submitting. */
    pending?: { prior_operation?: string[]; prior_read_of_data_class?: boolean };
    /**
     * What to do with the verdict: `enforced` — honour it before executing; `advisory` — the project
     * has declared a shadow window on Heron's side, so record the verdict and run anyway. The
     * execution you report is then published as a rehearsal rather than as a breach.
     *
     * Read this instead of carrying a shadow switch of your own. The mode is declared by an operator
     * in Heron, dated and signed into the decision receipt (`enforcement.effect`), because a runtime
     * that decided its own posture would declare shadow truthfully on every call and leave no breach
     * to find — so the claim cannot come from the code being checked. One fact, one source, and this
     * is the field that carries it to you.
     *
     * Absent on a Heron older than the field, and absent means `enforced`: an SDK that finds nothing
     * here honours the verdict, which is what it did before there was anything to read.
     */
    effect?: "enforced" | "advisory";
  };
  receipt: { id: string; kid: string; alg: string; signature: string };
  chain: { prev_hash: string; record_hash: string };
}

/**
 * A request Heron did not answer.
 *
 * Carried rather than thrown wherever a verdict was being asked for: the caller of a policy gate
 * needs a decision, and an exception is not one. `retryable` records whether we gave up because the
 * answer could not arrive (a timeout, a 5xx, a dead socket) or because the request was wrong (a 4xx
 * — a bad key, a session we never opened), which is the difference between an outage and a bug.
 */
export class HeronUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "HeronUnavailableError";
  }
}

/**
 * How a cooperating vendor honours a verdict. Only a plain `ALLOW` runs; everything else is *do not
 * execute*, and a missing answer (Heron down or slow) is fail-closed by the same rule — no ALLOW, no
 * execution. The four non-ALLOW verdicts differ only in what the edge does *next*, never in whether it
 * runs this call as-is:
 *
 *   - `DENY`    — the call does not run; report `BLOCKED`.
 *   - `STEP_UP` — wait for a human; on their answer, submit a *new* action carrying `resolves_action`
 *                 / `human_decision` / `approver`, which re-enters and may lift to ALLOW.
 *   - `MODIFY`  — the call does not run as-is. The decision names a narrowing (`decision.transform`);
 *                 the edge produces a narrower call and submits it as a *new* action, which is judged
 *                 on its own. Heron never rewrites the call it does not hold (invariant #6).
 *   - `DEFER`   — the call is withheld pending context the session does not carry yet
 *                 (`decision.pending`). The edge establishes that context as an action, then re-submits
 *                 the original as a *new* action, which re-enters with the context now in the chain.
 *
 * So `mayExecute` is deliberately narrow: run on ALLOW, and for every other verdict the honouring is a
 * *new action*, never running this one. That is what keeps MODIFY and DEFER off the immutability rules.
 *
 * The one thing that widens it is `decision.effect: "advisory"` — Heron saying, in the signed receipt,
 * that this project has declared a shadow window and the verdict is a rehearsal. Passing it here is
 * how a vendor stops carrying a shadow switch of its own; leaving it out keeps the old behaviour
 * exactly, because absent means enforced.
 */
export function mayExecute(
  verdict: string | undefined | null,
  effect?: "enforced" | "advisory" | null,
): boolean {
  // A shadow window is Heron *telling* us, per action and in signed bytes, that this verdict is a
  // rehearsal — never an assumption we may make. That distinction is the whole reason there is still
  // no fail-open switch here: no answer at all remains "do not run", because an unreachable Heron
  // states nothing, and "we could not ask" must never read as "we were told it did not matter".
  if (effect === "advisory") return true;
  return verdict === "ALLOW";
}

/**
 * The hash a result is committed to under, computed where the result still is.
 *
 * Exported so an edge can reduce a tool's result to its hash the moment it has it, and hand only
 * that to whatever files the statement later. It is the identical function `execution()` applies to
 * `result`, so the two paths sign the same bytes — which is the point: a second hash function here
 * would silently produce evidence that disagrees with itself.
 */
export function hashResult(result: unknown): string {
  return hashCanonical(result);
}

/** What a vendor may sign about what it did. See the wire schema for why ABANDONED exists. */
export type ExecutionOutcome =
  | "EXECUTED"
  | "SKIPPED"
  | "FAILED"
  | "BLOCKED"
  | "ESCALATED"
  | "ABANDONED";

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;

/**
 * How the client behaves once Heron has stopped answering.
 *
 * Every call has its own deadline and retries, which is right for a dropped packet and wrong for an
 * outage: the budget is then paid again on *every* tool call — three attempts, two seconds each, in
 * front of a result the agent is waiting for. Across one turn's fan-out that is seconds of latency
 * per turn, buying nothing, because the answer was never going to arrive. So after `threshold`
 * consecutive unanswered requests the client stops asking for `cooldownMs`, then lets exactly one
 * through to find out whether Heron is back.
 *
 * **This changes latency, not posture.** A request that fails and a request never made produce the
 * same thing — no action on the chain, no verdict, and the same fail-closed answer — so the breaker
 * cannot turn a blocked call into an allowed one. Only unanswered requests count: a 4xx is a bug in
 * the caller and retrying it is pointless, but so is treating it as evidence that Heron is down.
 *
 * What it must not do is fail silently, which is why opening and closing are reported rather than
 * swallowed. Pass `breaker: false` to disable it.
 */
export interface CircuitBreakerOptions {
  /** Consecutive unanswered requests before we stop asking. Default 5. */
  threshold?: number;
  /** How long to stop asking for. Default 30000. */
  cooldownMs?: number;
  /** Injectable so the behaviour can be tested without waiting out a real cooldown. */
  now?: () => number;
  onOpen?: (info: { threshold: number; cooldownMs: number }) => void;
  onClose?: () => void;
  /** The cooldown elapsed and one request is being let through to probe. */
  onProbe?: () => void;
}

class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;
  // Tracked explicitly rather than inferred from the counter: granting a probe has to drop us below
  // the threshold to let a call through, which made recovery indistinguishable from never having
  // opened — so the one event an operator waits for went unreported.
  private opened = false;

  constructor(private readonly options: CircuitBreakerOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  isOpen(): boolean {
    if (!this.opened) return false;
    if (this.now - this.openedAt >= (this.options.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS)) {
      // Half-open. Stamping the clock consumes the probe, so a fan-out arriving together does not
      // all pay full price at once.
      this.openedAt = this.now;
      this.options.onProbe?.();
      return false;
    }
    return true;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    const threshold = this.options.threshold ?? DEFAULT_BREAKER_THRESHOLD;
    if (!this.opened && this.consecutiveFailures >= threshold) {
      this.opened = true;
      this.openedAt = this.now;
      this.options.onOpen?.({
        threshold,
        cooldownMs: this.options.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS,
      });
    } else if (this.opened) {
      // The probe failed too: start the cooldown again.
      this.openedAt = this.now;
    }
  }

  recordSuccess(): void {
    if (this.opened) {
      this.opened = false;
      this.options.onClose?.();
    }
    this.consecutiveFailures = 0;
  }
}

export class HeronClient {
  private readonly breaker: CircuitBreaker | null;

  constructor(private readonly options: HeronClientOptions) {
    this.breaker =
      options.breaker === false ? null : new CircuitBreaker(options.breaker ?? {});
  }

  /** Resolved per call, not captured once: a runtime that swaps in an instrumented `fetch` after
   * the client was built — tracing wrappers do this — must still be the one we go through. */
  private get doFetch(): typeof fetch {
    return this.options.fetch ?? globalThis.fetch;
  }

  /**
   * Replace a recipient with a stable token before it is sent.
   *
   * `<redacted:email>` in both the request and the arguments makes the two
   * indistinguishable — and "did the agent write to the person the user named?" becomes
   * unanswerable for everyone, including the vendor's own reviewer. A token keeps that
   * question answerable while the address itself stays here.
   *
   * Use it on every anchor, or on none: half-tokenised evidence compares nothing.
   */
  anchor(type: AnchorType, value: string): string {
    return pseudonymWith(this.options.pseudonymSecret, type, value, VENDOR_SCOPE);
  }

  /**
   * Commit to the bytes your confirmation UI rendered to a human (src/shown-text.ts).
   *
   * A method here rather than a bare helper for the reason `anchor()` is one: the key is the whole
   * privacy property, and a call that already holds it is one nobody can forget to key. Hand it the
   * text you showed — the digest crosses, the text stays on this side.
   */
  shownTextHash(text: string): string {
    return shownTextHash({ text, key: this.options.pseudonymSecret });
  }

  async openSession(input: {
    externalId: string;
    agent: { externalId: string; name?: string; version?: string };
    principal: { type: "human" | "service"; ref: string };
    originalRequest: string;
    startedAt?: Date;
  }): Promise<{ session_id: string; head_hash: string }> {
    return this.post(
      "/v1/sessions",
      {
        external_id: input.externalId,
        agent: {
          external_id: input.agent.externalId,
          name: input.agent.name,
          version: input.agent.version,
        },
        principal: input.principal,
        original_request: {
          // The hash is over the *full* text, so it cannot be restated later. What travels
          // beside it is the anchors alone — the same tokens `anchor()` puts in the
          // arguments, which is the whole of what the comparison needs. The prose stays
          // here: it is the user's conversation, Heron is not entitled to it, and a
          // rendering that tokenises only emails and phone numbers is not a redaction.
          hash: hashCanonical(input.originalRequest),
          anchors: collectAnchors(input.originalRequest, (type, value) =>
            this.anchor(type, value),
          ),
        },
        started_at: (input.startedAt ?? new Date()).toISOString(),
      },
      // Opening the same session twice is already a replay on Heron's side, so the key only has to
      // be stable across *our* retries of the same open.
      `session:${input.externalId}`,
    );
  }

  async beforeAction(input: {
    sessionExternalId: string;
    seq: number;
    tool: { name: string; provider?: string; server?: string };
    args: Record<string, unknown>;
    argsRedacted: Record<string, unknown>;
    /**
     * Facts about this call, computed on the vendor's side, where the conversation still exists:
     * whether the recipient is external, how much money moves, whether a human approved a step-up.
     * Scalars — never raw text (invariant #6). This is what an intent engine will have to work with,
     * since the transcript never leaves.
     *
     * The keys are the trust boundary's one movable part, and they live in a single place —
     * `SIGNAL_KEYS` in src/lib/contract.ts, which also records, per key, whether Heron can fall back
     * to deriving it from the tool name or whether the fact is pinned to your side. Send more of them
     * to move the boundary right (Heron guesses less); send none and the classifier derives what it
     * can and marks the rest `unknown`, which is itself a signal to the reviewer that you did not send
     * it. The step-up loop rides the same channel: to answer a STEP_UP you submit a *new* action
     * carrying `resolves_action` / `human_decision` / `approver`, never a mutation of the old one.
     */
    signals?: Partial<Record<SignalKey, string | number | boolean | null>>;
    resourceRef?: string;
    /**
     * The head this call believes it extends — the `record_hash` of the last receipt this session
     * observed. Heron checks it for *membership*, not equality, so a concurrent fan-out where every
     * sibling names the same head is honest and expected; naming a hash the session never issued is
     * the finding.
     */
    prevHash?: string;
    /**
     * The key that makes a retry a replay instead of a second action. Pass your own call identifier
     * whenever you have one (a tool-call id is ideal — it is stable across the retries your own
     * runtime performs, which a per-request random value is not). Defaults to a hash of the action's
     * own content, which is stable across ours.
     */
    idempotencyKey?: string;
  }): Promise<BeforeActionResult> {
    const body = {
      session_external_id: input.sessionExternalId,
      seq: input.seq,
      tool: input.tool,
      args_redacted: input.argsRedacted,
      args_hash: hashCanonical(input.args), // hash of the FULL args, computed here
      ...(input.signals ? { signals: input.signals } : {}),
      resource_ref: input.resourceRef,
      requested_at: new Date().toISOString(),
      ...(input.prevHash ? { chain: { prev_hash: input.prevHash } } : {}),
    };

    return this.post(
      "/v1/actions",
      body,
      input.idempotencyKey ??
        `action:${hashCanonical({
          session: input.sessionExternalId,
          seq: input.seq,
          tool: input.tool.name,
          args_hash: body.args_hash,
        })}`,
    );
  }

  async execution(input: {
    actionId: string;
    decisionId: string;
    outcome: ExecutionOutcome;
    /** The result itself, hashed here. Only the hash is ever sent. */
    result?: unknown;
    /**
     * The same hash, computed earlier by `hashResult()`. Takes precedence over `result`.
     *
     * This exists so that filing the statement can be moved off the process that held the result —
     * which is what a durable `deliver` queue requires. A queue can only carry serialisable data, so
     * without this the only way to hand the statement to a worker is to put the raw tool result on
     * the queue: a second copy of the user's data, in a system that keeps it, for a value we were
     * going to reduce to 32 bytes anyway. Hash where the result lives; queue the hash.
     */
    resultHash?: string | null;
    errorCode?: string | null;
    /** Test hook: corrupt the signature to prove Heron notices. */
    forgeSignature?: boolean;
  }): Promise<{ ok: boolean; signature_valid: boolean }> {
    const payload = buildExecutionEvidencePayload({
      actionId: input.actionId,
      decisionId: input.decisionId,
      outcome: input.outcome,
      resultHash:
        input.resultHash ?? (input.result === undefined ? null : hashResult(input.result)),
      errorCode: input.errorCode ?? null,
      executedAt: new Date().toISOString(),
    });

    const { seed } = keyPairFromSeed(this.options.vendorSeed);
    const signature = input.forgeSignature
      ? signCanonical({ ...payload, outcome: "SKIPPED" }, seed) // signs *something else*
      : signCanonical(payload, seed);

    return this.post(
      "/v1/executions",
      { ...payload, signature: { kid: this.options.vendorKid, alg: "Ed25519", value: signature } },
      // One statement per (action, outcome). Retrying must never file a second one, and the same
      // action legitimately reaches here twice only when we are re-sending the same statement.
      `execution:${input.actionId}:${input.outcome}`,
    );
  }

  async closeSession(sessionExternalId: string) {
    return this.post(
      `/v1/sessions/${encodeURIComponent(sessionExternalId)}/close`,
      {},
      `close:${sessionExternalId}`,
    );
  }

  /**
   * Publish what your tools *are* — one signed statement, sent on every process start.
   *
   * The catalogue is canonicalised and hashed here, and Heron is idempotent by that content: the
   * same facts resolve to the same row however many replicas send them, so "publish on boot" is the
   * intended usage rather than a stream of duplicates for your reviewer to read past. It answers a
   * different question from `signals`: this one is true of every call the tool will ever serve, and
   * the per-call signal always wins over it.
   *
   * The signed bytes are the canonical catalogue — the body minus `signature` — so anyone holding
   * the request can verify it without knowing anything about our transport. It is `PUT`, and unlike
   * the other three calls it is not in front of a tool call the agent is waiting on, so the retry
   * budget here is only about a blip: this client's retries are tens of milliseconds. A Heron
   * restart is longer than that, and waiting one out is the caller's schedule, not this method's.
   *
   * A bad signature is *not* an error here: Heron stores the catalogue and raises the finding
   * (refusing it would delete the evidence that a vendor's signing is broken, on the one artefact
   * whose whole question is "signed by whom"). So a `200` alone does not mean you published
   * something that verifies — read `signature_valid`.
   */
  async publishToolCatalog(entries: readonly CatalogEntry[]): Promise<{
    ok: boolean;
    catalog_hash: string;
    tools: number;
    signature_valid: boolean;
    replay?: boolean;
  }> {
    const catalog = buildToolCatalog(entries);
    const { seed } = keyPairFromSeed(this.options.vendorSeed);

    return this.send(
      "PUT",
      "/v1/tool-catalog",
      {
        ...catalog,
        signature: {
          kid: this.options.vendorKid,
          alg: "Ed25519",
          value: signCanonical(catalog, seed),
        },
      },
      // Keyed by what it says, not by when it was sent: two replicas booting together are one
      // statement, and a retry of it is the same statement again.
      `catalog:${catalogHash(catalog)}`,
    );
  }

  private async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    return this.send("POST", path, body, idempotencyKey);
  }

  private async send<T>(
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<T> {
    if (this.breaker?.isOpen()) {
      // Retryable, because this says nothing about the request: it says we are not asking right now.
      throw new HeronUnavailableError(
        `${path} → not attempted: Heron has not answered recently and the circuit is open`,
        null,
        true,
        0,
      );
    }

    const attempts = (this.options.retries ?? DEFAULT_RETRIES) + 1;
    let last: HeronUnavailableError | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const outcome = await this.attempt<T>(method, path, body, idempotencyKey);
      if ("value" in outcome) {
        this.breaker?.recordSuccess();
        return outcome.value;
      }

      last = new HeronUnavailableError(
        outcome.message,
        outcome.status,
        outcome.retryable,
        attempt,
      );
      if (!outcome.retryable || attempt === attempts) break;

      // Exponential, and small: this whole loop sits in front of a tool call the agent is waiting
      // on, so the budget is a couple of hundred milliseconds, not a couple of seconds.
      await sleep(50 * 2 ** (attempt - 1) + Math.floor(Math.random() * 25));
    }

    // Only an unanswered request is evidence that Heron is down. A 4xx was answered — by a rejection
    // we earned — and counting it would let one bad field in one tool's contract stop us asking
    // about every other call on the platform.
    if (last?.retryable !== false) this.breaker?.recordFailure();

    throw last ?? new HeronUnavailableError(`${path} failed`, null, false, attempts);
  }

  private async attempt<T>(
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ value: T } | { message: string; status: number | null; retryable: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await this.doFetch(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        return {
          message: `${path} → HTTP ${response.status}: ${text}`,
          status: response.status,
          // 429 and 5xx are Heron asking for a moment. A 4xx is us being wrong, and retrying a
          // rejected request only turns one bug into a burst of them.
          retryable: response.status === 429 || response.status >= 500,
        };
      }
      return { value: JSON.parse(text) as T };
    } catch (error) {
      // A dead socket, a DNS failure, or our own deadline. All three mean "no answer yet".
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        message: aborted
          ? `${path} → no answer within ${this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : `${path} → ${error instanceof Error ? error.message : String(error)}`,
        status: null,
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
