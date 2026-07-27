import { describe, expect, it } from "vitest";

import {
  keyPairFromSeed,
  toBase64Url,
  verifyCanonical,
} from "../src/crypto/ed25519";
import { hashCanonical } from "../src/crypto/hash";
import { HeronClient } from "../src/vendor-sdk";
import {
  CATALOG_SIGNAL_KEYS,
  buildToolCatalog,
  catalogHash,
  resolveCatalogEntry,
} from "../src/tool-catalog";

/**
 * A catalogue is signed by the vendor and verified by Heron, so the property that matters is that
 * both sides reach the same bytes from the same facts. That is exactly why this lives here rather
 * than being written twice: a sort order that differs between the two is not a failing test on the
 * server, it is an INVALID_VENDOR_SIGNATURE finding published against the vendor.
 */

const SEED = Buffer.alloc(32, 7).toString("base64");

describe("buildToolCatalog", () => {
  it("produces the same bytes from the same facts in any order", () => {
    // A vendor whose registry iterates a map has no stable order to offer, and must not publish a
    // "change" because of it.
    const a = buildToolCatalog([
      { name: "b.tool", signals: { op: "write" } },
      { name: "a.tool", signals: { op: "read" } },
    ]);
    const b = buildToolCatalog([
      { name: "a.tool", signals: { op: "read" } },
      { name: "b.tool", signals: { op: "write" } },
    ]);

    expect(a.tools.map((t) => t.name)).toEqual(["a.tool", "b.tool"]);
    expect(catalogHash(a)).toBe(catalogHash(b));
  });

  it("drops absent optionals rather than sending them as null", () => {
    const [entry] = buildToolCatalog([{ name: "a.tool", signals: { reversible: true } }]).tools;

    expect(entry).toEqual({ name: "a.tool", signals: { reversible: true } });
    expect(entry).not.toHaveProperty("provider");
    expect(entry).not.toHaveProperty("server");
  });

  it("keeps an empty entry, because stating nothing is a statement", () => {
    // The vendor listing a tool and offering no constant fact about it is an admission; a tool
    // missing from the catalogue entirely is an omission. A reviewer is owed the difference.
    const catalog = buildToolCatalog([{ name: "a.tool", signals: {} }]);

    expect(catalog.tools).toEqual([{ name: "a.tool", signals: {} }]);
  });

  it("carries only facts that are properties of the tool", () => {
    // A recipient count, an amount and a human's approval are facts about one *call*. Stating them
    // for a tool would assert them for every call it ever serves.
    for (const perCall of [
      "recipient_count",
      "record_count",
      "amount",
      "resolves_action",
      "human_decision",
      "approver",
      "human_authorized",
    ]) {
      expect(CATALOG_SIGNAL_KEYS).not.toContain(perCall);
    }
  });
});

describe("resolveCatalogEntry", () => {
  const catalog = buildToolCatalog([
    { name: "ATTIO_FIND_RECORD", signals: { data_class: "personal" }, server: "attio" },
  ]);

  it("matches by exact name only", () => {
    expect(resolveCatalogEntry(catalog, "ATTIO_FIND_RECORD")?.signals).toEqual({
      data_class: "personal",
    });
    expect(resolveCatalogEntry(catalog, "ATTIO_CREATE_RECORD")).toBeNull();
  });

  it("answers nothing when no catalogue is published", () => {
    expect(resolveCatalogEntry(null, "ATTIO_FIND_RECORD")).toBeNull();
  });
});

describe("HeronClient.publishToolCatalog", () => {
  function record() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new HeronClient({
      baseUrl: "http://heron.test",
      apiKey: "ak_test",
      vendorKid: "vk_test",
      vendorSeed: SEED,
      pseudonymSecret: Buffer.alloc(32, 9).toString("base64"),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ ok: true, catalog_hash: "sha256:x", tools: 1, signature_valid: true }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    return { client, calls };
  }

  it("PUTs the catalogue, and signs the body it sends", async () => {
    // Drop `signature` from the request and what is left is what was signed — so anyone holding the
    // request can verify it without knowing anything about this transport, or that the server
    // rebuilds the canonical form before checking.
    const { client, calls } = record();

    await client.publishToolCatalog([
      { name: "SESSION_MEMORY_WRITE", signals: { op: "write", destination: "internal" } },
    ]);

    const [call] = calls;
    expect(call?.init.method).toBe("PUT");
    expect(call?.url).toBe("http://heron.test/v1/tool-catalog");

    const sent = JSON.parse(String(call?.init.body)) as Record<string, unknown> & {
      signature: { value: string };
    };
    const { signature, ...signed } = sent;
    const publicKey = toBase64Url(keyPairFromSeed(SEED).publicKey);

    expect(verifyCanonical(signed, signature.value, publicKey)).toBe(true);
  });

  it("keys the request by what it says, so replicas booting together are one statement", async () => {
    // Publishing on every process start is the documented usage. Two replicas sending the same
    // facts are not two publications, and a retry of one is not a second.
    const { client, calls } = record();
    const entries = [{ name: "a.tool", signals: { op: "read" as const } }];

    await client.publishToolCatalog(entries);
    await client.publishToolCatalog([...entries]);

    const keys = calls.map((c) => (c.init.headers as Record<string, string>)["idempotency-key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(`catalog:${catalogHash(buildToolCatalog(entries))}`);
  });

  it("hashes the canonical form, not the request", async () => {
    // The reviewer recomputes `catalog_hash` from the published catalogue. If it were taken over
    // the wire body — signature and all — they could never reproduce it.
    const catalog = buildToolCatalog([{ name: "a.tool", signals: { op: "read" } }]);

    expect(catalogHash(catalog)).toBe(hashCanonical(catalog));
  });
});
