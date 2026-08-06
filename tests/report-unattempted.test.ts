import { describe, expect, it } from "vitest";

import { HeronClient } from "../src/vendor-sdk";
import { openGuardedSession } from "../src/vendor-guard";

/**
 * The calls your own side stops, which until now existed in your logs and nowhere else.
 *
 * A rate limit, a budget, a tool a viewer may not run, an agent that changed its mind — Heron sees
 * none of it, so the safest thing a platform does is the one thing its record cannot show. What
 * makes this path worth its own file is that its failure behaviour is the *opposite* of the
 * guard's: nothing is waiting on the answer, so an unreachable Heron must cost a row and never a
 * refusal path.
 */

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

function fakeHeron(over: { verdict?: string; failActions?: boolean } = {}) {
  const sent: Sent[] = [];
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push({ path, body });

    if (path === "/v1/sessions") return ok({ session_id: "sess_1", head_hash: "genesis_1" });
    if (path === "/v1/actions") {
      if (over.failActions) return new Response("upstream is down", { status: 503 });
      return ok({
        action_id: "act_1",
        decision: {
          decision_id: "dec_1",
          verdict: over.verdict ?? "ALLOW",
          engine: "policy",
        },
        receipt: { id: "r_1", kid: "hk", alg: "Ed25519", signature: "s" },
        chain: { prev_hash: "genesis_1", record_hash: "rh_1" },
      });
    }
    return ok({ ok: true, signature_valid: true });
  };

  return {
    sent,
    client: new HeronClient({
      baseUrl: "http://heron.test",
      apiKey: "ak_test",
      vendorKid: "vk_test",
      vendorSeed: Buffer.alloc(32, 3).toString("base64"),
      pseudonymSecret: Buffer.alloc(32, 9).toString("base64"),
      fetch: fetchImpl as unknown as typeof fetch,
      retries: 0,
      breaker: false,
    }),
  };
}

function open(heron: ReturnType<typeof fakeHeron>, onError?: (e: unknown) => void) {
  return openGuardedSession({
    heron: heron.client,
    contracts: {},
    agent: { externalId: "agent_1" },
    principal: { type: "human", ref: "principal_1" },
    request: "send the summary",
    sessionExternalId: "run_1",
    onError,
  });
}

const call = { name: "gmail.send", args: { subject: "hi" }, id: "c1" };

describe("reporting a call that was never attempted", () => {
  it("files the action and a NOT_ATTEMPTED statement against it", async () => {
    const heron = fakeHeron({ verdict: "DENY" });
    const session = await open(heron);

    const report = await session.reportUnattempted(call, { errorCode: "rate_limited" });

    expect(report.actionId).toBe("act_1");
    expect(report.decisionId).toBe("dec_1");

    const execution = heron.sent.find((s) => s.path === "/v1/executions");
    expect(execution?.body["outcome"]).toBe("NOT_ATTEMPTED");
    expect(execution?.body["action_id"]).toBe("act_1");
    expect(execution?.body["error_code"]).toBe("rate_limited");
    // Nothing ran, so there is no result to hash and nothing may be invented for one.
    expect(execution?.body["result_hash"]).toBeNull();
  });

  it("hands back the verdict as a measurement, not as clearance", async () => {
    // The reason to return it at all: an ALLOW means the vendor's own limit stopped something the
    // published policy permits — the two rulebooks diverging, which is otherwise invisible from
    // either side. It is deliberately not a GuardDecision: every branch of that type is something a
    // caller acts on, and this call has already been refused.
    const heron = fakeHeron({ verdict: "ALLOW" });
    const session = await open(heron);

    const report = await session.reportUnattempted(call);

    expect(report.wouldHaveBeen).toBe("ALLOW");
    expect(report).not.toHaveProperty("kind");
  });

  it("costs a row and never the refusal path when Heron is unreachable", async () => {
    // The inversion that matters. `decide()` fails closed because a run is waiting on its answer;
    // here the call is already not happening, so failing closed could only break a refusal path
    // that was working. The row is lost, which is exactly what happens to every one of these calls
    // today — the failure mode is the status quo, not a new one.
    const errors: unknown[] = [];
    const heron = fakeHeron({ failActions: true });
    const session = await open(heron, (e) => errors.push(e));

    const report = await session.reportUnattempted(call);

    expect(report).toEqual({ actionId: null, decisionId: null, wouldHaveBeen: null });
    expect(errors).toHaveLength(1);
    expect(heron.sent.some((s) => s.path === "/v1/executions")).toBe(false);
  });

  it("reduces the arguments through the same contract a real call would have used", async () => {
    // A call that did not happen must not be the cheap way to get an argument across the boundary.
    const heron = fakeHeron();
    const session = await openGuardedSession({
      heron: heron.client,
      contracts: { "gmail.send": { keep: ["subject"] } },
      agent: { externalId: "agent_1" },
      principal: { type: "human", ref: "principal_1" },
      request: "send the summary",
      sessionExternalId: "run_1",
    });

    await session.reportUnattempted({
      name: "gmail.send",
      args: { subject: "hi", body: "the private part" },
      id: "c1",
    });

    const action = heron.sent.find((s) => s.path === "/v1/actions");
    expect(action?.body["args_redacted"]).toEqual({ subject: "hi" });
  });
});
