import { describe, expect, it } from "vitest";

import { INSTRUCTIONS_SIGNAL, instructionsHash } from "../src/instructions";
import { SIGNAL_KEY_LIST } from "../src/contract";

/**
 * The commitment to the agent's governing text. Its whole worth is that it is inert and comparable:
 * a digest that could move a verdict would be a new way to steer one, and a digest that cannot be
 * compared publishes "the instructions changed" on every action carrying it.
 */

describe("instructionsHash", () => {
  it("produces the shape the wire accepts, and only that", () => {
    // Heron refuses anything but `sha256:<64 hex>` with a 400, because an unparseable commitment
    // would compare unequal to every value including a later copy of itself.
    expect(instructionsHash({ system: "you are a billing agent" })).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it("is deterministic", () => {
    const once = instructionsHash({ system: "s", plan: "p" });
    expect(instructionsHash({ system: "s", plan: "p" })).toBe(once);
  });

  it("separates the slots, so moving text between them is a change", () => {
    // Over the canonical form of two fields rather than their concatenation: text moved from the
    // system prompt into the plan block would otherwise hash identically and publish as `unchanged`,
    // which is exactly the rewrite this signal exists to make visible.
    expect(instructionsHash({ system: "ab", plan: "c" })).not.toBe(
      instructionsHash({ system: "a", plan: "bc" }),
    );
  });

  it("tells no plan block from an empty one", () => {
    expect(instructionsHash({ system: "s" })).not.toBe(instructionsHash({ system: "s", plan: "" }));
    // `undefined` and an explicit `null` are the same statement: there is no plan block.
    expect(instructionsHash({ system: "s" })).toBe(instructionsHash({ system: "s", plan: null }));
  });
});

describe("the commitment is not part of the classifier's vocabulary", () => {
  it("is absent from SIGNAL_KEYS", () => {
    // Structural, not a convention. `SIGNAL_KEYS` is what a rule can be written against; a rule that
    // could turn on this value would hand the audited party a new way to steer a decision, and the
    // scalar is worth having precisely because nothing can.
    expect(SIGNAL_KEY_LIST).not.toContain(INSTRUCTIONS_SIGNAL);
  });
});
