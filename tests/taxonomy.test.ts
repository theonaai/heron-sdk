import { describe, expect, it } from "vitest";

import { DIMENSIONS, type Source, sourceConfidence, sourceRank } from "../src/policy/taxonomy";
import { formatInferredDimensions, parseInferredDimensions } from "../src/contract";

/**
 * `sourceRank` is the only place the strength ordering of a signal's provenance is written down,
 * and a rule's `min_source` floor is compared against it. Getting the order wrong does not fail
 * loudly — it silently lets a rule that demanded a per-call declaration fire on a tool-level
 * catalogue entry, or stops one that should fire. So the order is asserted, not assumed.
 */

describe("sourceRank", () => {
  it("orders declared > catalogued > inferred > derived > unknown", () => {
    expect(sourceRank("declared")).toBeGreaterThan(sourceRank("catalogued"));
    expect(sourceRank("catalogued")).toBeGreaterThan(sourceRank("inferred"));
    expect(sourceRank("inferred")).toBeGreaterThan(sourceRank("derived"));
    expect(sourceRank("derived")).toBeGreaterThan(sourceRank("unknown"));
  });

  it("keeps unknown at the floor, so a missing dimension can never satisfy a min_source", () => {
    expect(sourceRank("unknown")).toBe(0);
  });

  it("ranks every member of the union, so adding one cannot leave it unranked", () => {
    const all: Source[] = ["declared", "catalogued", "inferred", "derived", "unknown"];
    const ranks = all.map(sourceRank);
    expect(new Set(ranks).size).toBe(all.length);
  });
});

/**
 * The cut confidence is made on is *stated vs not stated*, and it used to be read off the ordinals
 * (`rank >= 2` was high). Inserting `inferred` at rank 2 under that reading would have promoted a
 * model's word to `high` in silence — the exact substitution the fifth source exists to prevent.
 */
describe("sourceConfidence", () => {
  it("calls a stated fact high, whether it describes the call or the tool", () => {
    expect(sourceConfidence("declared")).toBe("high");
    expect(sourceConfidence("catalogued")).toBe("high");
  });

  it("never lets a model's word read as confidently as a measurement", () => {
    expect(sourceConfidence("inferred")).toBe("medium");
    expect(sourceConfidence("derived")).toBe("medium");
  });

  it("keeps an undetermined dimension low, which is what drives it to a human", () => {
    expect(sourceConfidence("unknown")).toBe("low");
  });
});

/**
 * Both sides read this encoding — the SDK writes it, our classifier reads it, and the reviewer's
 * browser re-reads it to reproduce the verdict. A mis-parse does not throw; it leaves the dimension
 * labelled `declared`, which is the one outcome the whole distinction exists to prevent.
 */
describe("inferred dimensions", () => {
  it("round-trips the cascade", () => {
    expect(parseInferredDimensions(formatInferredDimensions([...DIMENSIONS]))).toEqual([
      ...DIMENSIONS,
    ]);
  });

  it("emits a stable order regardless of how the caller listed them", () => {
    expect(formatInferredDimensions(["magnitude", "operation"])).toBe(
      formatInferredDimensions(["operation", "magnitude"]),
    );
  });

  it("tolerates whitespace, since the string is hand-written as often as generated", () => {
    expect(parseInferredDimensions("data_class, magnitude")).toEqual(["data_class", "magnitude"]);
  });

  it("drops a name that is not a dimension rather than rejecting bytes already signed", () => {
    expect(parseInferredDimensions("data_class,human_decision")).toEqual(["data_class"]);
  });

  it("cannot name an approval signal, so a model can never sign off on its own step-up", () => {
    expect(parseInferredDimensions("resolves_action,human_decision,approver")).toEqual([]);
  });
});
