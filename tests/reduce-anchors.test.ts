import { describe, expect, it } from "vitest";

import type { AnchorType } from "../src/pseudonym-core";
import { reduce } from "../src/vendor-guard";

/**
 * What crosses the boundary when a contract names an anchor.
 *
 * The rule the whole reduction rests on: a key the contract calls an anchor never crosses raw. What
 * this file adds is the shape almost every send API actually uses — a *list* of recipients — which
 * was silently dropped, so the comparison anchors exist for saw one name where the call named
 * hundreds.
 */

const anchor = (type: AnchorType, value: string) => `anc_${type}_${value}`;

describe("reduce", () => {
  it("tokenises every entry of a recipient list", () => {
    const out = reduce(
      {
        to: "lead@corp.test",
        bcc: ["a@x.test", "b@y.test"],
        body: "the private part",
      },
      { anchors: { to: "email", bcc: "email" } },
      anchor,
    );

    expect(out).toEqual({
      to: "anc_email_lead@corp.test",
      bcc: ["anc_email_a@x.test", "anc_email_b@y.test"],
    });
    // The body was never listed, so it never crossed — the property that does not depend on anchors.
    expect(out).not.toHaveProperty("body");
  });

  it("drops a list entry it cannot tokenise rather than passing it through", () => {
    // Preserving the length by copying the odd entry verbatim would put a raw value on the wire
    // under a key the contract promised was anchored. A reduction may fail by carrying less; it may
    // never fail by carrying more.
    const out = reduce(
      { cc: ["a@x.test", { email: "b@y.test" }, 42] },
      { anchors: { cc: "email" } },
      anchor,
    );

    expect(out).toEqual({ cc: ["anc_email_a@x.test"] });
  });

  it("still lets an anchor beat keep for the same key, list or not", () => {
    const out = reduce(
      { cc: ["a@x.test"], subject: "hi" },
      { keep: ["cc", "subject"], anchors: { cc: "email" } },
      anchor,
    );

    expect(out).toEqual({ cc: ["anc_email_a@x.test"], subject: "hi" });
  });

  it("says nothing about a key the call did not carry", () => {
    // An absent recipient list must not become an empty one: `{}` and `{ bcc: [] }` are different
    // claims about the call, and the second is one the caller never made.
    const out = reduce(
      { to: "lead@corp.test" },
      { anchors: { to: "email", bcc: "email" } },
      anchor,
    );

    expect(out).toEqual({ to: "anc_email_lead@corp.test" });
  });
});
