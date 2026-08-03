import { describe, expect, it } from "vitest";

import { HeronClient } from "../src/vendor-sdk";
import {
  derivedSessionStore,
  memorySessionStore,
  openGuardedSession,
  type SessionStore,
} from "../src/vendor-guard";

/**
 * What the first action of a session claims to extend.
 *
 * `POST /v1/sessions` answers with the session's genesis hash, and until it was read the guard
 * threw it away — so the first action of every session carried no `chain` block at all, and a head
 * left in the store by an *earlier* session could be claimed by a later one. Both failures are
 * about the same missing line, and both are visible only on the wire, which is why these tests
 * drive the real `HeronClient` against a stubbed transport rather than a hand-written client: the
 * assertion is about the bytes Heron receives.
 */

interface SubmittedAction {
  session: string;
  seq: number;
  prevHash: string | undefined;
}

interface FakeHeron {
  client: HeronClient;
  actions: SubmittedAction[];
  /** Every hash this session has issued — genesis plus each action's record hash. */
  issued(session: string): Set<string>;
  genesis(session: string): string;
  /** Hold every `/v1/actions` response until `release()` is called. */
  hold(): () => void;
}

function fakeHeron(): FakeHeron {
  const actions: SubmittedAction[] = [];
  const issued = new Map<string, Set<string>>();
  const genesis = new Map<string, string>();
  let opens = 0;
  let records = 0;
  let gate: Promise<void> | null = null;

  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, never>;

    if (path === "/v1/sessions") {
      const external = String(body["external_id"]);
      // A fresh genesis on every open, even for an external id we have seen before: that is what a
      // returning principal whose runtime survived a cut-over to a new project actually gets.
      const head = `genesis_${++opens}`;
      genesis.set(external, head);
      issued.set(external, new Set([head]));
      return ok({ session_id: `sess_${opens}`, head_hash: head });
    }

    if (path === "/v1/actions") {
      const session = String(body["session_external_id"]);
      const chain = body["chain"] as { prev_hash?: string } | undefined;
      actions.push({ session, seq: Number(body["seq"]), prevHash: chain?.prev_hash });
      if (gate) await gate;
      const recordHash = `rh_${++records}`;
      issued.get(session)?.add(recordHash);
      return ok({
        action_id: `act_${records}`,
        decision: { decision_id: `dec_${records}`, verdict: "ALLOW", engine: "policy" },
        receipt: { id: `r_${records}`, kid: "hk", alg: "Ed25519", signature: "s" },
        chain: { prev_hash: chain?.prev_hash ?? null, record_hash: recordHash },
      });
    }

    return ok({ ok: true });
  };

  return {
    client: new HeronClient({
      baseUrl: "http://heron.test",
      apiKey: "ak_test",
      vendorKid: "vk_test",
      vendorSeed: Buffer.alloc(32, 3).toString("base64"),
      pseudonymSecret: Buffer.alloc(32, 9).toString("base64"),
      fetch: fetchImpl as unknown as typeof fetch,
    }),
    actions,
    issued: (session) => issued.get(session) ?? new Set(),
    genesis: (session) => genesis.get(session) ?? "",
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

function open(heron: FakeHeron, sessionExternalId: string, store?: SessionStore) {
  return openGuardedSession({
    heron: heron.client,
    contracts: {},
    agent: { externalId: "agent_1" },
    principal: { type: "human", ref: "principal_1" },
    request: "send the summary",
    sessionExternalId,
    store,
  });
}

const call = (id: string) => ({ name: "gmail.send", args: { subject: "hi" }, id });

describe("a session's first action", () => {
  it("claims the genesis the open returned", async () => {
    const heron = fakeHeron();
    const session = await open(heron, "run_1");

    const decision = await session.decide(call("c1"));

    expect(decision.kind).toBe("run");
    expect(heron.actions).toHaveLength(1);
    expect(heron.actions[0]!.prevHash).toBe(heron.genesis("run_1"));
  });

  it("does not inherit the previous session's head from a store that outlives it", async () => {
    const heron = fakeHeron();
    // One store for the whole process, which is the only way a head survives a session boundary —
    // and exactly the shape a long-lived runtime has.
    const store = memorySessionStore();

    const first = await open(heron, "run_1", store);
    await first.decide(call("c1"));
    const firstHead = heron.issued("run_1");

    const second = await open(heron, "run_1", store);
    await second.decide(call("c2"));

    const secondFirstAction = heron.actions[1]!;
    expect(secondFirstAction.prevHash).toBe(heron.genesis("run_1"));
    expect(secondFirstAction.prevHash).not.toBe("rh_1");
    expect(firstHead.has("rh_1")).toBe(true);
  });

  it("does not inherit it under derivedSessionStore either", async () => {
    const heron = fakeHeron();
    const store = derivedSessionStore();

    const first = await open(heron, "run_1", store);
    await first.decide(call("c1"));

    const second = await open(heron, "run_1", store);
    await second.decide(call("c2"));

    expect(heron.actions[1]!.prevHash).toBe(heron.genesis("run_1"));
    expect(heron.actions[1]!.prevHash).not.toBe("rh_1");
  });
});

describe("a fan-out within one session", () => {
  it("reserves distinct positions and claims only hashes the session issued", async () => {
    const heron = fakeHeron();
    const session = await open(heron, "run_1");
    const release = heron.hold();

    // All three dispatched before any response lands, which is what an agent that fans a turn out
    // into parallel tool calls does.
    const pending = Promise.all([
      session.decide(call("c1")),
      session.decide(call("c2")),
      session.decide(call("c3")),
    ]);
    // Let the three reservations and submissions run before anything is answered.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const decisions = await pending;

    expect(decisions.map((d) => d.kind)).toEqual(["run", "run", "run"]);
    expect(new Set(heron.actions.map((a) => a.seq)).size).toBe(3);
    // Siblings naming the same head is honest — Heron checks membership, not equality.
    for (const action of heron.actions) {
      expect(action.prevHash).toBe(heron.genesis("run_1"));
      expect(heron.issued("run_1").has(action.prevHash!)).toBe(true);
    }
  });
});
