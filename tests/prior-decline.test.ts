import { describe, expect, it } from "vitest";

import { type ApprovalSignals, type Signals, openGuardedSession } from "../src/vendor-guard";
import { HeronClient } from "../src/vendor-sdk";

/**
 * The prior decline — a refusal the vendor's own UI collected before Heron was asked.
 *
 * The server accepts it and publishes it, and it moves no verdict, which makes it the mirror of
 * `human_authorized`. What kept a TypeScript vendor from sending it was `ApprovalSignals`: the
 * step-up member demands `resolves_action`, and the prior-approval member pins `human_decision` to
 * `never`, so the one call every integration wants to make did not compile.
 *
 * The assertions below are mostly type-level on purpose. `npm run typecheck` covers `tests`, so a
 * `@ts-expect-error` that stops being an error fails the build — which is the only place the
 * contradictory pair can be caught, since the SDK does no runtime validation of the approval shape
 * and the 400 that refuses it is the server's.
 */

function fakeHeron() {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    sent.push({
      path,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });

    if (path === "/v1/sessions") return ok({ session_id: "sess_1", head_hash: "genesis_1" });
    if (path === "/v1/actions") {
      return ok({
        action_id: "act_1",
        decision: { decision_id: "dec_1", verdict: "ALLOW", engine: "policy" },
        receipt: { id: "r_1", kid: "hk", alg: "Ed25519", signature: "s" },
        chain: { prev_hash: "genesis_1", record_hash: "rh_1" },
      });
    }
    return ok({ ok: true });
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
    }),
  };
}

function open(heron: ReturnType<typeof fakeHeron>) {
  return openGuardedSession({
    heron: heron.client,
    contracts: { "gmail.send": { keep: ["subject"] } },
    agent: { externalId: "agent_1" },
    principal: { type: "human", ref: "principal_1" },
    request: "reply in the thread",
    sessionExternalId: "run_1",
  });
}

describe("a decline collected before Heron was asked", () => {
  it("compiles as a lone human_decision, with and without an approver", () => {
    const withApprover: ApprovalSignals = {
      human_decision: "DECLINE",
      approver: "rev_7",
    };
    const alone: ApprovalSignals = { human_decision: "DECLINE" };

    // `approver` is optional and stays absent rather than becoming null: the signals object is
    // hashed into the chain record, so a key present and empty is a statement nobody made.
    expect(withApprover).toEqual({ human_decision: "DECLINE", approver: "rev_7" });
    expect(alone).not.toHaveProperty("approver");
  });

  it("reaches the wire in signals, unchanged", async () => {
    const heron = fakeHeron();
    const session = await open(heron);

    await session.decide(
      { name: "gmail.send", args: { subject: "q3 numbers" }, id: "c1" },
      { human_decision: "DECLINE", approver: "rev_7" },
    );

    const action = heron.sent.find((s) => s.path === "/v1/actions");
    const signals = action?.body.signals as Record<string, unknown> | undefined;
    expect(signals?.human_decision).toBe("DECLINE");
    expect(signals?.approver).toBe("rev_7");
    // It names no action of ours, and must not acquire one on the way out.
    expect(signals).not.toHaveProperty("resolves_action");
    expect(signals).not.toHaveProperty("human_authorized");
  });

  it("does not admit the pair the server refuses", () => {
    // Cleared and refused by the same person on the same call. There is no member of the union it
    // fits, so it never reaches the 400 that would otherwise be the first time anyone found out.
    const contradiction: ApprovalSignals = {
      human_decision: "DECLINE",
      // @ts-expect-error — cleared and refused at once is not a statement anyone can act on
      human_authorized: true,
    };
    expect(contradiction).toBeDefined();
  });

  it("still refuses a prior APPROVE that names no action", () => {
    // The reason the union exists in the first place: an approval only lifts a step-up it names, so
    // a bare `human_decision: "APPROVE"` would be silently inert. Widening for the decline must not
    // have widened that hole — a decline is inert by design, an approval is inert by accident.
    // @ts-expect-error — an approval must name the step-up it lifts
    const bareApprove: ApprovalSignals = { human_decision: "APPROVE" };
    expect(bareApprove).toBeDefined();
  });

  it("still requires human_decision beside a resolves_action", () => {
    // @ts-expect-error — naming an action without stating the decision is the incomplete form
    const noDecision: ApprovalSignals = { resolves_action: "act_9", approver: "rev_7" };
    expect(noDecision).toBeDefined();
  });

  it("composes with the rest of the signals a call carries", () => {
    // `Signals` intersects `ApprovalSignals` with the standalone keys; the new member has to survive
    // that intersection or the shape only works when it is sent on its own.
    const signals: Signals = {
      op: "send",
      recipient_count: 3,
      human_decision: "DECLINE",
      approver: "rev_7",
      shown_text_hash: "sth_abc",
    };
    expect(signals.human_decision).toBe("DECLINE");
  });
});
