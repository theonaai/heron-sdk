import { describe, expect, it } from "vitest";

import { type Source, sourceRank } from "../src/policy/taxonomy";

/**
 * `sourceRank` is the only place the strength ordering of a signal's provenance is written down,
 * and a rule's `min_source` floor is compared against it. Getting the order wrong does not fail
 * loudly — it silently lets a rule that demanded a per-call declaration fire on a tool-level
 * catalogue entry, or stops one that should fire. So the order is asserted, not assumed.
 */

describe("sourceRank", () => {
  it("orders declared > catalogued > derived > unknown", () => {
    expect(sourceRank("declared")).toBeGreaterThan(sourceRank("catalogued"));
    expect(sourceRank("catalogued")).toBeGreaterThan(sourceRank("derived"));
    expect(sourceRank("derived")).toBeGreaterThan(sourceRank("unknown"));
  });

  it("keeps unknown at the floor, so a missing dimension can never satisfy a min_source", () => {
    expect(sourceRank("unknown")).toBe(0);
  });

  it("ranks every member of the union, so adding one cannot leave it unranked", () => {
    const all: Source[] = ["declared", "catalogued", "derived", "unknown"];
    const ranks = all.map(sourceRank);
    expect(new Set(ranks).size).toBe(all.length);
  });
});
