import { describe, expect, it } from "vitest";

import { type ContractMap, resolveContract } from "../src/vendor-guard";

/**
 * Group keys exist because the exact-name form does not survive a platform: the first production
 * window of the first integration carried 228 distinct tools and not one declared `data_class`, for
 * the sole reason that saying it meant writing 228 contracts.
 *
 * What these tests hold is the part that makes a group key safe to sign: the answer is a function of
 * the call and the map, never of the order the map was written in, and a narrow key can add a field
 * without silently dropping a wider key's signals.
 */

const signals = (tag: string) => () => ({ data_class: tag });

describe("resolveContract", () => {
  it("matches a glob over tool names", () => {
    const contracts: ContractMap = { "ATTIO_*": { signals: signals("personal") } };

    expect(resolveContract({ name: "ATTIO_FIND_RECORD" }, contracts).signals).toBeDefined();
    expect(resolveContract({ name: "GITHUB_GET_FILE" }, contracts).signals).toBeUndefined();
  });

  it("matches the server and the provider the vendor resolved the call to", () => {
    const contracts: ContractMap = {
      "server:attio": { signals: signals("personal") },
      "provider:composio": { signals: signals("operational") },
    };

    const byServer = resolveContract({ name: "x", server: "attio", provider: "composio" }, contracts);
    // The server is the narrower statement, so it wins over the provider that contains it.
    expect(byServer.signals?.({} as never)).toEqual({ data_class: "personal" });

    const byProvider = resolveContract({ name: "x", provider: "composio" }, contracts);
    expect(byProvider.signals?.({} as never)).toEqual({ data_class: "operational" });
  });

  it("prefers the exact name, then the more literal glob, then server, then provider", () => {
    const contracts: ContractMap = {
      "provider:composio": { signals: signals("provider") },
      "server:attio": { signals: signals("server") },
      "ATTIO_*": { signals: signals("wide-glob") },
      "ATTIO_CREATE_*": { signals: signals("narrow-glob") },
    };
    const call = { name: "ATTIO_CREATE_RECORD", server: "attio", provider: "composio" };

    expect(resolveContract(call, contracts).signals?.({} as never)).toEqual({
      data_class: "narrow-glob",
    });

    const withExact: ContractMap = { ...contracts, ATTIO_CREATE_RECORD: { signals: signals("exact") } };
    expect(resolveContract(call, withExact).signals?.({} as never)).toEqual({ data_class: "exact" });
  });

  it("does not depend on the order the map was written in", () => {
    const wide = { signals: signals("wide") };
    const narrow = { signals: signals("narrow") };
    const call = { name: "ATTIO_CREATE_RECORD" };

    const a = resolveContract(call, { "ATTIO_*": wide, "ATTIO_CREATE_*": narrow });
    const b = resolveContract(call, { "ATTIO_CREATE_*": narrow, "ATTIO_*": wide });

    // A signal is signed testimony; "it depended on which key was typed first" is not an answer a
    // vendor can give a reviewer.
    expect(a.signals?.({} as never)).toEqual(b.signals?.({} as never));
    expect(a.signals?.({} as never)).toEqual({ data_class: "narrow" });
  });

  it("lets a narrow key add a field without dropping the group's signals", () => {
    // The merge is per field, not per contract. Whole-contract precedence would lose `data_class` on
    // exactly the one tool that got a `keep` — a signal vanishing because an unrelated field was
    // added elsewhere, which nobody finds until a reviewer asks about one call in a thousand.
    const contracts: ContractMap = {
      "ATTIO_*": { signals: signals("personal") },
      ATTIO_CREATE_RECORD: { keep: ["title"] },
    };

    const resolved = resolveContract({ name: "ATTIO_CREATE_RECORD" }, contracts);

    expect(resolved.keep).toEqual(["title"]);
    expect(resolved.signals?.({} as never)).toEqual({ data_class: "personal" });
  });

  it("never unions two allowlists", () => {
    // `keep` decides what leaves the vendor's boundary. Merging the contents would let a wide key
    // add a field a narrow contract deliberately did not list — invariant #6 defeated by convenience.
    const contracts: ContractMap = {
      "ATTIO_*": { keep: ["body", "email"] },
      ATTIO_CREATE_RECORD: { keep: ["title"] },
    };

    expect(resolveContract({ name: "ATTIO_CREATE_RECORD" }, contracts).keep).toEqual(["title"]);
  });

  it("returns an empty contract when nothing matches", () => {
    expect(resolveContract({ name: "unknown.tool" }, { "ATTIO_*": { keep: ["a"] } })).toEqual({});
  });

  it("treats a glob's other characters literally", () => {
    // `.` and `+` are ordinary characters in a tool name, not regex syntax: a key written for
    // `gmail.send` must not also claim `gmailXsend`.
    const contracts: ContractMap = { "gmail.*": { keep: ["subject"] } };

    expect(resolveContract({ name: "gmail.send" }, contracts).keep).toEqual(["subject"]);
    expect(resolveContract({ name: "gmailXsend" }, contracts).keep).toBeUndefined();
  });
});
