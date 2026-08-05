import { describe, expect, it } from "vitest";

import { SIGNAL_KEY_LIST } from "../src/contract";
import { SHOWN_TEXT_SIGNAL, shownTextHash } from "../src/shown-text";
import { openGuardedSession } from "../src/vendor-guard";
import { HeronClient } from "../src/vendor-sdk";

/**
 * The commitment to what a human was shown before they approved.
 *
 * Two properties carry the whole feature and both are asserted on the wire rather than in the type
 * system: the digest travels in `signals` (so `signals_hash` puts it in the chained record and the
 * vendor cannot restate afterwards what it showed), and the **text never does**. The third is that
 * it is keyed — without that, a published `signals_hash` plus a guessable prompt is a confirmation
 * oracle for the person the prompt names.
 */

const KEY = Buffer.alloc(32, 9).toString("base64");
const PROMPT = "Send this contract to 240 recipients outside your company?";

describe("shownTextHash", () => {
  it("produces the shape the wire accepts, and only that", () => {
    // Heron refuses anything but `sha256:<64 hex>` with a 400: this digest is never compared with
    // anything of theirs, so one nobody can reproduce later binds the vendor to nothing while still
    // publishing the approval as bound to its prompt.
    expect(shownTextHash({ text: PROMPT, key: KEY })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic, or the commitment proves nothing later", () => {
    expect(shownTextHash({ text: PROMPT, key: KEY })).toBe(shownTextHash({ text: PROMPT, key: KEY }));
  });

  it("is keyed: the same prompt under another key is another digest", () => {
    // The privacy property. `signals_hash` is published and confirmation prompts are templates with
    // a name dropped in, so an unkeyed digest would let anyone holding a candidate address confirm
    // it. A key that never leaves the vendor removes that and costs the commitment nothing.
    expect(shownTextHash({ text: PROMPT, key: KEY })).not.toBe(
      shownTextHash({ text: PROMPT, key: "another-secret" }),
    );
  });

  it("separates the key from the text, so a shift between them is a different commitment", () => {
    // Over a canonical object rather than a concatenation, for the reason `instructionsHash` is:
    // otherwise `{key: "ab", text: "c"}` and `{key: "a", text: "bc"}` collide.
    expect(shownTextHash({ key: "ab", text: "c" })).not.toBe(shownTextHash({ key: "a", text: "bc" }));
  });
});

describe("the commitment is not part of the classifier's vocabulary", () => {
  it("is absent from SIGNAL_KEYS", () => {
    // Structural rather than a convention, and the direction matters: a rule that could fire on this
    // would make *omitting* it the cheapest way out, so the vendor with the worst confirmation
    // prompts would have the strongest reason to send nothing.
    expect(SIGNAL_KEY_LIST).not.toContain(SHOWN_TEXT_SIGNAL);
  });
});

/** The transport, stubbed: the assertion is about the bytes Heron receives. */
function fakeHeron() {
  const submitted: Array<Record<string, unknown>> = [];
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  let n = 0;

  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (path === "/v1/sessions") return ok({ session_id: "sess_1", head_hash: "genesis_1" });
    if (path === "/v1/actions") {
      submitted.push(body);
      n += 1;
      return ok({
        action_id: `act_${n}`,
        // The first call is the gate; the resolution that follows is allowed.
        decision: {
          decision_id: `dec_${n}`,
          verdict: n === 1 ? "STEP_UP" : "ALLOW",
          engine: "policy",
        },
        receipt: { id: `r_${n}`, kid: "hk", alg: "Ed25519", signature: "s" },
        chain: { prev_hash: null, record_hash: `rh_${n}` },
      });
    }
    return ok({ ok: true });
  };

  return {
    submitted,
    client: new HeronClient({
      baseUrl: "http://heron.test",
      apiKey: "ak_test",
      vendorKid: "vk_test",
      vendorSeed: Buffer.alloc(32, 3).toString("base64"),
      pseudonymSecret: KEY,
      fetch: fetchImpl as unknown as typeof fetch,
    }),
  };
}

describe("resolveStepUp carries it", () => {
  it("sends the digest and never the prompt", async () => {
    const heron = fakeHeron();
    const session = await openGuardedSession({
      heron: heron.client,
      contracts: {},
      agent: { externalId: "agent_1" },
      principal: { type: "human", ref: "user_1" },
      request: "send the contract",
      sessionExternalId: "run_1",
    });

    const gate = await session.decide({ name: "gmail.send", args: { to: "a@b.example" } });
    expect(gate.kind).toBe("step_up");

    await session.resolveStepUp({
      actionId: gate.kind === "step_up" ? gate.actionId : "",
      call: { name: "gmail.send", args: { to: "a@b.example" } },
      approved: true,
      approver: "op_7",
      shownText: PROMPT,
    });

    const resolution = heron.submitted[1]!;
    const signals = resolution["signals"] as Record<string, unknown>;
    expect(signals[SHOWN_TEXT_SIGNAL]).toBe(shownTextHash({ text: PROMPT, key: KEY }));
    // The point of passing the *text* to the SDK: what leaves is a digest keyed with a secret Heron
    // never holds, and the prompt itself is nowhere in the request body (invariant #6).
    expect(JSON.stringify(resolution)).not.toContain("240 recipients");
  });

  it("says nothing rather than something empty when there is no prompt to commit to", async () => {
    // An absent key and a key holding `undefined` are not the same statement, and this object is
    // hashed into the chain record — so the difference is permanent.
    const heron = fakeHeron();
    const session = await openGuardedSession({
      heron: heron.client,
      contracts: {},
      agent: { externalId: "agent_1" },
      principal: { type: "human", ref: "user_1" },
      request: "send the contract",
      sessionExternalId: "run_1",
    });

    const gate = await session.decide({ name: "gmail.send", args: {} });
    await session.resolveStepUp({
      actionId: gate.kind === "step_up" ? gate.actionId : "",
      call: { name: "gmail.send", args: {} },
      approved: true,
      approver: "op_7",
    });

    const signals = heron.submitted[1]!["signals"] as Record<string, unknown>;
    expect(SHOWN_TEXT_SIGNAL in signals).toBe(false);
  });
});
