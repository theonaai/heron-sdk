import { describe, expect, it } from "vitest";

import {
  keyPairFromSeed,
  toBase64Url,
  verifyCanonical,
} from "../src/crypto/ed25519";
import { hashCanonical } from "../src/crypto/hash";
import { HeronClient } from "../src/vendor-sdk";
import {
  type ToolCatalog,
  CATALOG_SIGNAL_KEYS,
  buildToolCatalog,
  catalogConflicts,
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

  it("can say a delete is recoverable without claiming it is undoable", () => {
    // The value `reversible` cannot express. Without it a vendor whose delete is recoverable at a
    // cost — a record their agent regenerates, a file behind a backup — must either overclaim
    // `true` or accept `terminal`, and the rule that allows a recoverable delete is unreachable by
    // declaration. A vocabulary that punishes the honest answer teaches vendors to stop answering.
    const [entry] = buildToolCatalog([
      { name: "recommendations_delete", signals: { op: "delete", reversibility: "costly" } },
    ]).tools;

    expect(entry?.signals).toEqual({ op: "delete", reversibility: "costly" });
  });

  it("leaves a catalogue that states no aliases byte-for-byte as it was", () => {
    // The reason this is a `v: 1` addition and not a format break. Every receipt already issued
    // names a `catalog_hash`; if an added optional changed the bytes of a catalogue that does not
    // use it, every one of those receipts would name a catalogue nobody can reproduce.
    const before: ToolCatalog = {
      v: 1,
      tools: [{ name: "a.tool", signals: { op: "read" } }],
    };

    expect(buildToolCatalog([{ name: "a.tool", signals: { op: "read" } }])).toEqual(before);
    expect(buildToolCatalog([{ name: "a.tool", signals: { op: "read" }, aliases: [] }])).toEqual(
      before,
    );
    expect(catalogHash(buildToolCatalog([{ name: "a.tool", signals: { op: "read" } }]))).toBe(
      catalogHash(before),
    );
  });

  it("sorts and de-duplicates aliases, and drops the tool's own name from them", () => {
    // Same facts, same bytes — the alias list comes out of a vendor's rename history, which is even
    // less likely to have a stable order than their tool registry. Its own name is a statement with
    // no content.
    const a = buildToolCatalog([
      {
        name: "EXECUTE_AGENT",
        signals: {},
        aliases: ["run_agent", "execute_agent", "run_agent", "EXECUTE_AGENT"],
      },
    ]);
    const b = buildToolCatalog([
      { name: "EXECUTE_AGENT", signals: {}, aliases: ["execute_agent", "run_agent"] },
    ]);

    expect(a.tools[0]?.aliases).toEqual(["execute_agent", "run_agent"]);
    expect(catalogHash(a)).toBe(catalogHash(b));
  });

  it("sorts by code unit, so the bytes do not depend on the host's locale", () => {
    // `localeCompare()` would answer from the host's ICU locale and build: a default locale orders
    // `execute_agent` before `EXECUTE_AGENT`, `da_DK` disagrees, and `--without-intl` degrades to
    // code units. Two replicas would then hash identical facts differently and publish a "change"
    // that is only a re-ordering. Code units are a property of the strings — the assertions below
    // are the order `localeCompare()` does *not* give.
    const catalog = buildToolCatalog([
      { name: "a.tool", signals: {} },
      { name: "B.tool", signals: {}, aliases: ["execute_agent", "EXECUTE_AGENT"] },
    ]);

    expect(catalog.tools.map((entry) => entry.name)).toEqual(["B.tool", "a.tool"]);
    expect(catalog.tools[0]?.aliases).toEqual(["EXECUTE_AGENT", "execute_agent"]);
  });

  it("refuses to canonicalise two entries for one tool", () => {
    // Sorting is stable, so the pair would land in the vendor's enumeration order — the one thing
    // this function exists to keep out of the bytes. Silently, it is two hashes for one registry
    // and two answers to one question: one replica says `internal`, the other `external`. There is
    // no honest canonical form to pick between entries that disagree, so it is raised at the
    // vendor's own boot, by name, rather than published as a contradiction.
    expect(() =>
      buildToolCatalog([
        { name: "mail.send", signals: { destination: "internal" } },
        { name: "mail.send", signals: { destination: "external" } },
      ]),
    ).toThrow(/mail\.send/);

    // Same name on one entry is not the case: repeating an alias, or naming itself, states nothing.
    expect(() =>
      buildToolCatalog([{ name: "mail.send", signals: {}, aliases: ["mail.send", "send", "send"] }]),
    ).not.toThrow();
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

  it("resolves a name the vendor declared as an alias of this tool", () => {
    // The rename case: `EXECUTE_AGENT` is what the vendor calls it today, `execute_agent` is what
    // 1 410 calls in the 10.08 window actually arrived under, and no rename going forward can reach
    // them.
    const renamed = buildToolCatalog([
      { name: "EXECUTE_AGENT", signals: { op: "execute" }, aliases: ["execute_agent"] },
    ]);

    expect(resolveCatalogEntry(renamed, "execute_agent")?.name).toBe("EXECUTE_AGENT");
    expect(resolveCatalogEntry(renamed, "EXECUTE_AGENT")?.name).toBe("EXECUTE_AGENT");
    expect(resolveCatalogEntry(renamed, "delete_agent")).toBeNull();
  });

  it("gives a live tool its own entry, never an alias somebody else claimed", () => {
    // A vendor retires `legacy.send` and later ships a different tool under that name. Inheriting
    // the old tool's `destination: internal` would attach a fact to calls it was never about — the
    // one way an alias could make a verdict quietly wrong.
    const catalog = buildToolCatalog([
      { name: "legacy.send", signals: { destination: "external" } },
      { name: "mail.send", signals: { destination: "internal" }, aliases: ["legacy.send"] },
    ]);

    expect(resolveCatalogEntry(catalog, "legacy.send")?.signals).toEqual({
      destination: "external",
    });
  });

  it("answers nothing when two tools claim the same alias", () => {
    // Pure and total: a reviewer runs this offline over whatever was published. Picking the first
    // match would make the answer depend on sort order — a detail nobody signed. `null` says the
    // true thing, and the call falls back to being classified from its name.
    const catalog = buildToolCatalog([
      { name: "a.send", signals: { op: "send" }, aliases: ["send"] },
      { name: "b.send", signals: { op: "write" }, aliases: ["send"] },
    ]);

    expect(resolveCatalogEntry(catalog, "send")).toBeNull();
  });
});

describe("catalogConflicts", () => {
  it("says nothing about a catalogue whose aliases all resolve", () => {
    const catalog = buildToolCatalog([
      { name: "EXECUTE_AGENT", signals: {}, aliases: ["execute_agent"] },
      { name: "mail.send", signals: {} },
    ]);

    expect(catalogConflicts(catalog)).toEqual({ refuse: [], report: [] });
  });

  it("names an alias two tools claim, so the vendor is refused rather than silently unmatched", () => {
    const catalog = buildToolCatalog([
      { name: "b.send", signals: {}, aliases: ["send"] },
      { name: "a.send", signals: {}, aliases: ["send"] },
    ]);

    expect(catalogConflicts(catalog)).toEqual({
      refuse: [{ name: "send", reason: "ambiguous", claimedBy: ["a.send", "b.send"] }],
      report: [],
    });
  });

  it("puts a shadowed alias in `report`, where refusing on a non-empty list cannot reach it", () => {
    // The door-check the docstring describes is `if (refuse.length) return 400`. Written over one
    // flat list it would reject this catalogue — the vendor whose old name is now a live tool,
    // which the design requires accepting, since the alternative is being unable to publish
    // anything about their current tools until they tidy their rename history.
    const catalog = buildToolCatalog([
      { name: "legacy.send", signals: {} },
      { name: "mail.send", signals: {}, aliases: ["legacy.send"] },
    ]);
    const { refuse, report } = catalogConflicts(catalog);

    expect(refuse).toEqual([]);
    expect(report).toEqual([
      { name: "legacy.send", reason: "shadowed", claimedBy: ["mail.send"] },
    ]);
  });

  it("reads a catalogue it did not build the way resolution reads it", () => {
    // The door-check runs over whatever bytes arrived, not over something `buildToolCatalog` just
    // normalised. A hand-signed catalogue repeating an alias, or naming the tool itself, states
    // nothing `resolveCatalogEntry` cannot answer — refusing it would be the two halves of this
    // file disagreeing about what an alias means.
    const raw: ToolCatalog = {
      v: 1,
      tools: [
        { name: "a.send", signals: {}, aliases: ["send", "send", "a.send"] },
        { name: "mail.send", signals: {} },
      ],
    };

    expect(resolveCatalogEntry(raw, "send")?.name).toBe("a.send");
    expect(catalogConflicts(raw)).toEqual({ refuse: [], report: [] });
  });

  it("calls a double-claimed alias shadowed, not ambiguous, when a live tool answers it", () => {
    // `resolveCatalogEntry` never reaches its alias pass here — `legacy.send` is a live name, and
    // the name pass already decided. Reporting the fatal reason would refuse the catalogue over a
    // case resolution fully determines, stranding the vendor on their own rename history.
    const catalog = buildToolCatalog([
      { name: "legacy.send", signals: {} },
      { name: "b.send", signals: {}, aliases: ["legacy.send"] },
      { name: "a.send", signals: {}, aliases: ["legacy.send"] },
    ]);

    expect(resolveCatalogEntry(catalog, "legacy.send")?.name).toBe("legacy.send");
    expect(catalogConflicts(catalog)).toEqual({
      refuse: [],
      report: [{ name: "legacy.send", reason: "shadowed", claimedBy: ["a.send", "b.send"] }],
    });
  });

  it("refuses two entries for one tool, which only bytes we did not build can carry", () => {
    // `buildToolCatalog` throws on this, so the door-check is the only place it can be met. Left
    // standing, resolution answers whichever entry sorted first — the vendor's enumeration order,
    // which is exactly what canonicalisation exists to keep out of the answer.
    const raw: ToolCatalog = {
      v: 1,
      tools: [
        { name: "mail.send", signals: { destination: "internal" } },
        { name: "mail.send", signals: { destination: "external" } },
      ],
    };

    expect(catalogConflicts(raw)).toEqual({
      refuse: [
        { name: "mail.send", reason: "duplicate_name", claimedBy: ["mail.send", "mail.send"] },
      ],
      report: [],
    });
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
