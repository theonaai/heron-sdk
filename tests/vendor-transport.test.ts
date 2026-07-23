import { describe, expect, it } from "vitest";

import { HeronClient, HeronUnavailableError } from "../src/vendor-sdk";

/**
 * The transport, under the failures a hosted dependency actually produces.
 *
 * This sits in front of every tool call a vendor's agents make, which makes two of its properties
 * load-bearing rather than nice: it must have a deadline, because the only thing a hung
 * `before_action` can do is stop the vendor's run forever; and its retries must be replays, because
 * Heron judging the same action twice puts two actions in an immutable chain where the vendor made
 * one call.
 */

interface Recorded {
  path: string;
  idempotencyKey: string | null;
}

function client(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  over: {
    timeoutMs?: number;
    retries?: number;
    breaker?: ConstructorParameters<typeof HeronClient>[0]["breaker"];
  } = {},
) {
  return new HeronClient({
    baseUrl: "http://heron.test",
    apiKey: "ak_test",
    vendorKid: "vk_test",
    vendorSeed: Buffer.alloc(32, 3).toString("base64"),
    pseudonymSecret: Buffer.alloc(32, 9).toString("base64"),
    fetch: fetchImpl as unknown as typeof fetch,
    ...over,
  });
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const beforeAction = {
  action_id: "act_1",
  decision: { decision_id: "dec_1", verdict: "ALLOW", engine: "policy" },
  receipt: { id: "r", kid: "hk", alg: "Ed25519", signature: "s" },
  chain: { prev_hash: "h0", record_hash: "rh_1" },
};

function record(): { calls: Recorded[]; capture: (url: string, init: RequestInit) => void } {
  const calls: Recorded[] = [];
  return {
    calls,
    capture(url, init) {
      const headers = new Headers(init.headers);
      calls.push({ path: new URL(url).pathname, idempotencyKey: headers.get("idempotency-key") });
    },
  };
}

const action = {
  sessionExternalId: "run_1",
  seq: 0,
  tool: { name: "gmail.send" },
  args: { to: "a@b.example", subject: "hi" },
  argsRedacted: { subject: "hi" },
};

describe("the vendor transport", () => {
  it("retries a 5xx and replays under the same idempotency key", async () => {
    const { calls, capture } = record();
    let n = 0;
    const heron = client(async (url, init) => {
      capture(url, init);
      n += 1;
      return n < 3 ? new Response("upstream", { status: 503 }) : ok(beforeAction);
    });

    const result = await heron.beforeAction(action);

    expect(result.action_id).toBe("act_1");
    expect(calls).toHaveLength(3);
    // The point of retrying at all: Heron replays the decision it already made rather than judging
    // a second action. A per-request random key — which is what this used to send — would have put
    // three actions in the chain for one tool call.
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(1);
  });

  it("does not retry a 4xx — a rejected request is a bug, and retrying multiplies it", async () => {
    const { calls, capture } = record();
    const heron = client(async (url, init) => {
      capture(url, init);
      return new Response("unknown session", { status: 404 });
    });

    await expect(heron.beforeAction(action)).rejects.toBeInstanceOf(HeronUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it("gives up on its own deadline rather than holding the agent open", async () => {
    const heron = client(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          // Never answers. Only the abort signal ends this.
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
      { timeoutMs: 20, retries: 0 },
    );

    const error = await heron.beforeAction(action).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HeronUnavailableError);
    expect((error as HeronUnavailableError).retryable).toBe(true);
    expect((error as HeronUnavailableError).status).toBeNull();
  });

  it("keys an execution statement by action and outcome, so a resend files one statement", async () => {
    const { calls, capture } = record();
    const heron = client(async (url, init) => {
      capture(url, init);
      return ok({ ok: true, signature_valid: true });
    });

    const evidence = { actionId: "act_1", decisionId: "dec_1", outcome: "EXECUTED" } as const;
    await heron.execution(evidence);
    await heron.execution(evidence);

    expect(calls.map((c) => c.idempotencyKey)).toEqual([
      "execution:act_1:EXECUTED",
      "execution:act_1:EXECUTED",
    ]);
  });

  it("derives a stable key from the action's own content when the caller has none", async () => {
    const { calls, capture } = record();
    const heron = client(async (url, init) => {
      capture(url, init);
      return ok(beforeAction);
    });

    await heron.beforeAction(action);
    await heron.beforeAction(action);
    const [first, second] = calls;

    expect(first!.idempotencyKey).toBe(second!.idempotencyKey);
  });

  it("prefers the caller's own key — a tool-call id survives retries the SDK never sees", async () => {
    const { calls, capture } = record();
    const heron = client(async (url, init) => {
      capture(url, init);
      return ok(beforeAction);
    });

    await heron.beforeAction({ ...action, idempotencyKey: "toolcall_abc" });

    expect(calls[0]!.idempotencyKey).toBe("toolcall_abc");
  });
});

/**
 * The breaker changes latency, never posture: a request that fails and a request never made produce
 * the same fail-closed answer. What it must not do is keep paying a full retry budget per tool call
 * for an answer that was never going to arrive — across one turn's fan-out that is seconds bought
 * for nothing.
 *
 * The clock is injected because state that only reveals itself after thirty seconds is state nobody
 * ends up testing.
 */
describe("the circuit breaker in front of an unanswering Heron", () => {
  function breaking(over: { threshold?: number; cooldownMs?: number } = {}) {
    let clock = 1_000;
    const events: string[] = [];
    let attempts = 0;
    let answer: (() => Response) | null = null;

    const heron = client(
      async () => {
        attempts++;
        if (answer) return answer();
        throw new Error("connection refused");
      },
      {
        retries: 0,
        breaker: {
          threshold: over.threshold ?? 3,
          cooldownMs: over.cooldownMs ?? 30_000,
          now: () => clock,
          onOpen: () => events.push("open"),
          onClose: () => events.push("close"),
          onProbe: () => events.push("probe"),
        },
      },
    );

    return {
      heron,
      events,
      advance: (ms: number) => (clock += ms),
      attempts: () => attempts,
      recover: () => (answer = () => ok(beforeAction)),
      ask: () => heron.beforeAction(action).then(() => "ok" as const, () => "failed" as const),
    };
  }

  it("stops asking once the threshold of unanswered requests is reached", async () => {
    const t = breaking({ threshold: 3 });

    expect(await t.ask()).toBe("failed");
    expect(await t.ask()).toBe("failed");
    expect(t.attempts()).toBe(2);
    expect(t.events).toEqual([]);

    expect(await t.ask()).toBe("failed");
    expect(t.events).toEqual(["open"]);

    // The fourth call never reaches the network at all.
    expect(await t.ask()).toBe("failed");
    expect(t.attempts()).toBe(3);
  });

  it("lets exactly one probe through when the cooldown elapses, and closes on an answer", async () => {
    const t = breaking({ threshold: 3, cooldownMs: 30_000 });
    for (let i = 0; i < 3; i++) await t.ask();

    t.advance(29_999);
    await t.ask();
    expect(t.attempts()).toBe(3);

    t.advance(1);
    t.recover();
    expect(await t.ask()).toBe("ok");
    expect(t.events).toEqual(["open", "probe", "close"]);
    expect(t.attempts()).toBe(4);
  });

  it("never counts a 4xx: one bad field must not stop us asking about every other call", async () => {
    // A rejected request was *answered*. Treating it as evidence that Heron is down would let one
    // malformed contract take the whole platform's guard offline for thirty seconds at a time.
    let opened = false;
    const heron = client(async () => new Response("bad signals", { status: 400 }), {
      retries: 0,
      breaker: { threshold: 2, onOpen: () => (opened = true) },
    });

    for (let i = 0; i < 5; i++) {
      await expect(heron.beforeAction(action)).rejects.toBeInstanceOf(HeronUnavailableError);
    }
    expect(opened).toBe(false);
  });

  it("can be turned off", async () => {
    let attempts = 0;
    const heron = client(
      async () => {
        attempts++;
        throw new Error("connection refused");
      },
      { retries: 0, breaker: false },
    );

    for (let i = 0; i < 6; i++) {
      await expect(heron.beforeAction(action)).rejects.toBeInstanceOf(HeronUnavailableError);
    }
    expect(attempts).toBe(6);
  });
});
