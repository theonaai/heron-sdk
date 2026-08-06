import { describe, expect, it } from "vitest";

import {
  type ContractMap,
  openGuardedSession,
  resolveContract,
} from "../src/vendor-guard";
import { HeronClient } from "../src/vendor-sdk";

/**
 * `resource_ref` — the one key that can link two sessions through the object they both touched.
 *
 * The wire has carried it since v1 and `HeronClient.beforeAction` has always accepted it; what did
 * not exist was any way for a *contract* to state it, so every vendor on the documented path
 * reported it on 0% of calls and read as having declined to send it.
 */

function fakeHeron() {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 });

  const fetchImpl = async (
    url: string,
    init: RequestInit,
  ): Promise<Response> => {
    const path = new URL(url).pathname;
    sent.push({
      path,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });

    if (path === "/v1/sessions")
      return ok({ session_id: "sess_1", head_hash: "genesis_1" });
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

function open(heron: ReturnType<typeof fakeHeron>, contracts: ContractMap) {
  return openGuardedSession({
    heron: heron.client,
    contracts,
    agent: { externalId: "agent_1" },
    principal: { type: "human", ref: "principal_1" },
    request: "reply in the thread",
    sessionExternalId: "run_1",
  });
}

describe("a contract's resource", () => {
  it("reaches the wire as resource_ref", async () => {
    const heron = fakeHeron();
    const session = await open(heron, {
      "gmail.send": { resource: ({ args }) => String(args.thread_id) },
    });

    await session.decide({
      name: "gmail.send",
      args: { thread_id: "thr_88" },
      id: "c1",
    });

    const action = heron.sent.find((s) => s.path === "/v1/actions");
    expect(action?.body["resource_ref"]).toBe("thr_88");
  });

  it("says nothing when the call acts on no nameable resource", async () => {
    // The ordinary case, and it must stay absent rather than become an empty string: a key present
    // and empty is hashed into the chain record as a statement the caller never made.
    const heron = fakeHeron();
    const session = await open(heron, {
      "gmail.send": {
        resource: ({ args }) =>
          args.thread_id ? String(args.thread_id) : undefined,
      },
    });

    await session.decide({ name: "gmail.send", args: {}, id: "c1" });

    const action = heron.sent.find((s) => s.path === "/v1/actions");
    expect(action?.body).not.toHaveProperty("resource_ref");
  });

  it("resolves through the same specificity rules as the rest of the contract", () => {
    const contracts: ContractMap = {
      "server:jira": { resource: () => "wide" },
      JIRA_DELETE_ISSUE: { keep: ["issue_key"] },
    };

    // The narrow key states `keep` and says nothing about the resource, so it must not silently
    // drop the wider key's answer — the property `resolveContract` holds for every other field.
    const resolved = resolveContract(
      { name: "JIRA_DELETE_ISSUE", server: "jira" },
      contracts,
    );
    expect(resolved.keep).toEqual(["issue_key"]);
    expect(
      resolved.resource?.({ args: {}, request: "", anchor: () => "" }),
    ).toBe("wide");
  });
});
