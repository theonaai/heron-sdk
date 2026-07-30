import { describe, expect, it } from "vitest";

import { mayExecute } from "../src/vendor-sdk";
import { type GuardClient, openGuardedSession } from "../src/vendor-guard";

/**
 * A shadow window is Heron telling us, per action and in signed bytes, that a verdict is a rehearsal.
 * These tests pin the two halves of that: the vendor may stop carrying a switch of its own, and
 * nothing about being told may become something we assume when nobody told us.
 */

function client(decision: Record<string, unknown>): GuardClient {
  return {
    anchor: (_type: string, value: string) => `tok_${value.length}`,
    openSession: async () => ({ session_id: "ses_1", chain: { genesis_hash: "sha256:0" } }),
    beforeAction: async () => ({
      action_id: "act_1",
      decision: { decision_id: "dec_1", engine: "rules", ...decision } as never,
      receipt: { id: "rcp_1", kid: "hk", alg: "Ed25519", signature: "sig" },
      chain: { prev_hash: "sha256:0", record_hash: "sha256:1" },
    }),
    execution: async () => ({ ok: true }) as never,
    closeSession: async () => ({ ok: true }) as never,
  } as unknown as GuardClient;
}

async function decide(decision: Record<string, unknown>) {
  const session = await openGuardedSession({
    heron: client(decision),
    contracts: {},
    agent: { externalId: "agent_1", name: "Billing" },
    principal: { type: "human", ref: "user_1" },
    request: "send the invoice",
    sessionExternalId: "chat_1",
  });
  return session.decide({ name: "gmail.send", args: { to: "maria@acme.example" } });
}

describe("mayExecute", () => {
  it("runs a non-ALLOW verdict only when Heron says the window is advisory", () => {
    expect(mayExecute("ALLOW")).toBe(true);
    expect(mayExecute("DENY")).toBe(false);
    expect(mayExecute("DENY", "enforced")).toBe(false);
    expect(mayExecute("DENY", "advisory")).toBe(true);
  });

  it("still fails closed on no answer, whatever the effect argument says", () => {
    // The distinction the whole design rests on: "we were told this is a rehearsal" is a signed
    // statement about one action; "we could not ask" is nothing at all, and must not read as the
    // first. An unreachable Heron produces no decision, so no effect, so no execution.
    expect(mayExecute(undefined)).toBe(false);
    expect(mayExecute(null)).toBe(false);
    expect(mayExecute(undefined, "enforced")).toBe(false);
  });
});

describe("a guarded call in a declared shadow window", () => {
  it("runs a DENY and says it was a rehearsal", async () => {
    const decision = await decide({ verdict: "DENY", effect: "advisory" });

    expect(decision.kind).toBe("run");
    // The flag exists so the vendor can log the calls that would stop the day it declares
    // enforcement — a rehearsal that reads identically to an allowed call teaches nobody anything.
    expect(decision).toMatchObject({ kind: "run", verdict: "DENY", rehearsed: true });
  });

  it("does not mark an ordinary ALLOW as a rehearsal", async () => {
    const decision = await decide({ verdict: "ALLOW", effect: "advisory" });

    expect(decision).toMatchObject({ kind: "run", verdict: "ALLOW" });
    expect(decision).not.toHaveProperty("rehearsed");
  });

  it("blocks a DENY when the decision carries no effect at all", async () => {
    // A Heron older than the field states nothing, and absent means enforced: an SDK that finds
    // nothing here behaves exactly as it did before there was anything to read.
    const decision = await decide({ verdict: "DENY" });

    expect(decision.kind).toBe("blocked");
  });

  it("blocks a DENY the deployment declared it enforces", async () => {
    const decision = await decide({ verdict: "DENY", effect: "enforced" });

    expect(decision.kind).toBe("blocked");
  });
});
