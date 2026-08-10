import { describe, expect, it } from "vitest";

import { INSTRUCTIONS_SIGNAL, instructionsHash } from "../src/instructions";
import { type GuardOptions, openGuardedSession } from "../src/vendor-guard";
import { HeronClient } from "../src/vendor-sdk";

/**
 * `GuardOptions.instructions` — the commitment, sent by the guard instead of by every call site.
 *
 * The digest itself is old (src/instructions.ts); what is new is that the guard reads it. That
 * matters because of how the commitment is published: coverage is a number on the vendor's own page,
 * and a runtime that commits on some calls and not others is exactly the shape that hides a rewrite.
 * Threading `signals.instructions_hash` through every `decide()` by hand is how that shape happens —
 * the first integration to send this wrote its own `withInstructions()` wrapper, and every later one
 * would have written it again.
 *
 * The property under test is therefore not "the digest is correct" but **"every submission carries
 * one"**: `decide`, the step-up answer, and the call that was never attempted, since those are the
 * three doors an action reaches the wire through.
 */

function fakeHeron() {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    sent.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });

    if (path === "/v1/sessions") return ok({ session_id: "sess_1", head_hash: "genesis_1" });
    if (path === "/v1/actions") {
      return ok({
        action_id: `act_${sent.length}`,
        decision: { decision_id: "dec_1", verdict: "ALLOW", engine: "policy" },
        receipt: { id: "r_1", kid: "hk", alg: "Ed25519", signature: "s" },
        chain: { prev_hash: "genesis_1", record_hash: `rh_${sent.length}` },
      });
    }
    return ok({ ok: true });
  };

  return {
    sent,
    /** The signals of every action submitted, in order. */
    actions(): Array<Record<string, unknown> | undefined> {
      return sent
        .filter((entry) => entry.path === "/v1/actions")
        .map((entry) => entry.body.signals as Record<string, unknown> | undefined);
    },
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

function open(heron: ReturnType<typeof fakeHeron>, extra: Partial<GuardOptions> = {}) {
  return openGuardedSession({
    heron: heron.client,
    contracts: {},
    agent: { externalId: "agent_1" },
    principal: { type: "human", ref: "principal_1" },
    request: "reply in the thread",
    sessionExternalId: "run_1",
    ...extra,
  });
}

type Slot = { system: string; plan?: string | null };

const BEFORE: Slot = { system: "you are a billing assistant", plan: null };
const AFTER: Slot = { system: "you are a billing assistant", plan: "step 2" };

describe("the instruction slot", () => {
  it("commits on every submission without the call site saying so", async () => {
    const heron = fakeHeron();
    const session = await open(heron, { instructions: () => BEFORE });

    await session.decide({ id: "c1", name: "crm.get_customer", args: {} });
    await session.decide({ id: "c2", name: "crm.get_customer", args: {} });

    const digests = heron.actions().map((signals) => signals?.[INSTRUCTIONS_SIGNAL]);
    expect(digests).toEqual([instructionsHash(BEFORE), instructionsHash(BEFORE)]);
  });

  it("is read per submission, so a rewrite mid-session is what reaches the wire", async () => {
    // The reason this is a function and not a value. A slot captured at open would publish
    // `unchanged` straight through a rewrite — a false statement about the vendor's own agent, in a
    // record that cannot be corrected later.
    const heron = fakeHeron();
    let slot = BEFORE;
    const session = await open(heron, { instructions: () => slot });

    await session.decide({ id: "c1", name: "crm.get_customer", args: {} });
    slot = AFTER;
    await session.decide({ id: "c2", name: "crm.get_customer", args: {} });

    expect(heron.actions().map((s) => s?.[INSTRUCTIONS_SIGNAL])).toEqual([
      instructionsHash(BEFORE),
      instructionsHash(AFTER),
    ]);
  });

  it("carries through the call that was never attempted", async () => {
    const heron = fakeHeron();
    const session = await open(heron, { instructions: () => BEFORE });

    await session.reportUnattempted(
      { id: "c1", name: "gmail.send_email", args: {} },
      { errorCode: "budget_exhausted" },
    );

    expect(heron.actions()[0]?.[INSTRUCTIONS_SIGNAL]).toBe(instructionsHash(BEFORE));
  });

  it("carries through the approval answer, which brings signals of its own", async () => {
    // The third door, and the only one that submits with a `signals` object on every call.
    const heron = fakeHeron();
    const session = await open(heron, { instructions: () => BEFORE });

    await session.resolveStepUp({
      actionId: "act_1",
      call: { name: "gmail.send_email", args: {} },
      approved: true,
      approver: "op_7",
    });

    expect(heron.actions()[0]?.[INSTRUCTIONS_SIGNAL]).toBe(instructionsHash(BEFORE));
  });

  it("lets an explicit signal win — it is the narrower statement about that submission", async () => {
    const heron = fakeHeron();
    const session = await open(heron, { instructions: () => BEFORE });
    const explicit = instructionsHash(AFTER);

    await session.decide(
      { id: "c1", name: "crm.get_customer", args: {} },
      { [INSTRUCTIONS_SIGNAL]: explicit },
    );

    expect(heron.actions()[0]?.[INSTRUCTIONS_SIGNAL]).toBe(explicit);
  });

  it("is not dropped by a signals object that only carries the key", async () => {
    // The key is optional, so a caller that builds its signals from a value it did not have hands us
    // `instructions_hash: undefined` — present, and stating nothing. Only a value wins over the
    // commitment; carrying the key is not making the narrower statement.
    const heron = fakeHeron();
    const session = await open(heron, { instructions: () => BEFORE });

    await session.decide(
      { id: "c1", name: "crm.get_customer", args: {} },
      { [INSTRUCTIONS_SIGNAL]: undefined },
    );

    expect(heron.actions()[0]?.[INSTRUCTIONS_SIGNAL]).toBe(instructionsHash(BEFORE));
  });

  it("sends nothing when the option is not set", async () => {
    const heron = fakeHeron();
    const session = await open(heron);

    await session.decide({ id: "c1", name: "crm.get_customer", args: {} });

    // Asserted on a submission that happened: an absent action would satisfy the key check on its
    // own, and the test would then pass for the one reason it is there to rule out.
    expect(heron.actions()).toHaveLength(1);
    expect(heron.actions()[0]?.[INSTRUCTIONS_SIGNAL]).toBeUndefined();
  });

  it("never fails a tool call because the callback threw", async () => {
    // A diagnostic that has not been asked to gate anything must not be able to stop the thing it
    // reports on. The vendor is told, and the call proceeds without the key.
    const heron = fakeHeron();
    const errors: Array<{ stage: string; tool?: string }> = [];
    const session = await open(heron, {
      instructions: () => {
        throw new Error("no agent in scope");
      },
      onError: (_error, context) => errors.push(context),
    });

    const decision = await session.decide({ id: "c1", name: "crm.get_customer", args: {} });

    expect(decision.kind).toBe("run");
    expect(heron.actions()[0]?.[INSTRUCTIONS_SIGNAL]).toBeUndefined();
    expect(errors).toEqual([{ stage: "instructions", tool: "crm.get_customer" }]);
  });

  it("survives an onError that throws too, rather than failing the call on the report", async () => {
    const heron = fakeHeron();
    const session = await open(heron, {
      instructions: () => {
        throw new Error("no agent in scope");
      },
      onError: () => {
        throw new Error("the vendor's logger is down");
      },
    });

    const decision = await session.decide({ id: "c1", name: "crm.get_customer", args: {} });

    expect(decision.kind).toBe("run");
  });
});
