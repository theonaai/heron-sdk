import { describe, expect, it } from "vitest";

import { hashCanonical } from "../src/crypto/hash";
import { grantPayload, taskPayload } from "../src/delegation";
import { HeronClient } from "../src/vendor-sdk";

/**
 * The sending half of the two questions that had no field on the wire (src/delegation.ts).
 *
 * What is worth testing is the seam, not the mapping: the document a vendor hands us must not cross,
 * the digest must be one they can reproduce from their own record afterwards, and a run that states
 * nothing must send nothing — an absent field is a vendor that said nothing, and Heron's record has
 * to be able to tell that from a claim.
 */

function clientWith(record: (body: Record<string, unknown>) => void) {
  return new HeronClient({
    baseUrl: "http://heron.test",
    apiKey: "ak_test",
    vendorKid: "vk_test",
    vendorSeed: Buffer.alloc(32, 3).toString("base64"),
    pseudonymSecret: Buffer.alloc(32, 9).toString("base64"),
    fetch: (async (_url: string, init: RequestInit) => {
      record(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ session_id: "ses_1", head_hash: "sha256:0" }), {
        status: 200,
      });
    }) as unknown as typeof fetch,
  });
}

const OPEN = {
  externalId: "run_1",
  agent: { externalId: "agent_1" },
  principal: { type: "human" as const, ref: "user_881" },
  originalRequest: "Update the subscription",
};

describe("what crosses at session open", () => {
  it("sends the digest and keeps the delegation document here", async () => {
    let body: Record<string, unknown> = {};
    const document = { policy: "read-only", approvedBy: "maria@acme.example", ticket: "OPS-221" };

    await clientWith((b) => (body = b)).openSession({
      ...OPEN,
      task: { ref: "job_4471", parentSessionExternalId: "run_8810" },
      grant: { document, ref: "delegation_2261", scope: { allowedTools: ["crm.get_customer"] } },
    });

    expect(body.task).toEqual({ ref: "job_4471", parent_session_external_id: "run_8810" });
    expect(body.grant).toEqual({
      hash: hashCanonical(document),
      ref: "delegation_2261",
      scope: { allowed_tools: ["crm.get_customer"] },
    });
    // The whole point of taking the document rather than a digest: an address inside it never
    // reaches the wire, and no call site can forget to hash it.
    expect(JSON.stringify(body)).not.toContain("maria@acme.example");
    expect(JSON.stringify(body)).not.toContain("read-only");
  });

  it("sends neither key when the run states nothing", async () => {
    let body: Record<string, unknown> = {};
    await clientWith((b) => (body = b)).openSession(OPEN);
    expect("task" in body).toBe(false);
    expect("grant" in body).toBe(false);
  });
});

describe("the digest a vendor has to be able to reproduce", () => {
  it("does not depend on key order — an object is safe to hand us", () => {
    // hashCanonical is RFC 8785, so the document can be the record as it comes out of their own
    // store. Without this the vendor would have to serialise it themselves to reproduce the digest,
    // which is the mistake that makes a commitment unverifiable a month later.
    const a = grantPayload({ document: { b: 2, a: 1 } })!;
    const b = grantPayload({ document: { a: 1, b: 2 } })!;
    expect(a.hash).toBe(b.hash);
  });

  it("hashes different documents differently, including a near-miss", () => {
    const strict = grantPayload({ document: { allow: ["read"] } })!;
    const loose = grantPayload({ document: { allow: ["read", "write"] } })!;
    expect(strict.hash).not.toBe(loose.hash);
  });
});

describe("the named set, mapped and otherwise left alone", () => {
  it("keeps the order it was given, because Heron digests it as it arrives", () => {
    // Sorting or de-duplicating here would produce a digest the vendor cannot reproduce from their
    // own delegation record — invisible from their side, and only discovered when it matters.
    const payload = grantPayload({
      document: {},
      scope: { allowedTools: ["gmail.send", "crm.get_contact"] },
    })!;
    expect(payload.scope?.allowed_tools).toEqual(["gmail.send", "crm.get_contact"]);
  });

  it("carries the bounds through under the classifier's own names", () => {
    const payload = grantPayload({
      document: {},
      scope: { bounds: { operation: ["read", "send"], destination: ["internal"] } },
    })!;
    expect(payload.scope?.bounds).toEqual({
      operation: ["read", "send"],
      destination: ["internal"],
    });
  });

  it("takes a Date for the expiry and sends ISO 8601", () => {
    const payload = grantPayload({
      document: {},
      scope: { expiresAt: new Date("2026-08-05T18:00:00.000Z") },
    })!;
    expect(payload.scope?.expires_at).toBe("2026-08-05T18:00:00.000Z");
  });

  it("omits a scope nobody named rather than sending an empty one", () => {
    // An empty object would read as a grant that bounds nothing while claiming to bound something;
    // absent says what is true, which is that only the document was committed to.
    expect(grantPayload({ document: {} })).toEqual({ hash: hashCanonical({}) });
    expect(taskPayload(undefined)).toBeUndefined();
    expect(grantPayload(undefined)).toBeUndefined();
  });

  it("omits a parent nobody named", () => {
    expect(taskPayload({ ref: "job_1" })).toEqual({ ref: "job_1" });
  });
});
