import { describe, expect, it } from "vitest";

import { SIGNAL_KEYS } from "../src/contract";
import { classifyAtEdge } from "../src/edge-classify";

/**
 * The reference edge classifier. Two kinds of test here, and the second kind is the load-bearing one:
 * that it emits nothing it cannot see in the arguments. A classifier that quietly guessed would
 * repaint Heron's honest `derived` as `declared` and defeat `tallySignalSources()`.
 */

describe("what it reads from the arguments", () => {
  it("counts an array of recipients", () => {
    expect(classifyAtEdge({ to: ["a@x.example", "b@y.example"] })).toEqual({ recipient_count: 2 });
  });

  it("counts several addresses packed into one string field", () => {
    expect(classifyAtEdge({ to: "a@x.example, b@y.example" })).toEqual({ recipient_count: 2 });
  });

  it("counts a recipient that carries no anchor at all", () => {
    // A user id is still a recipient; magnitude does not depend on the value looking like an address.
    expect(classifyAtEdge({ recipient: "user_881" })).toEqual({ recipient_count: 1 });
  });

  it("sums recipients across to/cc/bcc", () => {
    const signals = classifyAtEdge({ to: "a@x.example", cc: ["b@x.example"], bcc: [] });
    expect(signals.recipient_count).toBe(2);
  });

  it("counts records by array length", () => {
    expect(classifyAtEdge({ ids: [1, 2, 3, 4] })).toEqual({ record_count: 4 });
  });

  it("emits nothing for a call whose arguments answer nothing", () => {
    expect(classifyAtEdge({ query: "quarterly numbers", limit: 10 })).toEqual({});
  });

  it("ignores an empty recipient field rather than claiming one recipient", () => {
    expect(classifyAtEdge({ to: "   ", ids: [] })).toEqual({});
  });

  it("reads the argument keys a vendor names instead of the conventions", () => {
    const signals = classifyAtEdge(
      { addressee: ["a@x.example"], to: ["ignored@x.example"] },
      { fields: { recipients: ["addressee"] } },
    );
    expect(signals.recipient_count).toBe(1);
  });
});

describe("destination — only against a stated perimeter", () => {
  it("stays silent without internalDomains, rather than guessing a perimeter", () => {
    expect(classifyAtEdge({ to: "someone@outside.example" })).toEqual({ recipient_count: 1 });
  });

  it("calls an address outside the listed domains external", () => {
    const signals = classifyAtEdge(
      { to: "someone@outside.example" },
      { internalDomains: ["acme.example"] },
    );
    expect(signals.recipient_external).toBe(true);
  });

  it("calls an address inside the listed domains internal", () => {
    const signals = classifyAtEdge(
      { to: "colleague@acme.example" },
      { internalDomains: ["acme.example"] },
    );
    expect(signals.recipient_external).toBe(false);
  });

  it("treats a subdomain of an internal domain as internal", () => {
    const signals = classifyAtEdge(
      { to: "ops@mail.acme.example" },
      { internalDomains: ["acme.example"] },
    );
    expect(signals.recipient_external).toBe(false);
  });

  it("is external when any one recipient is outside — the blast radius is the widest one", () => {
    const signals = classifyAtEdge(
      { to: ["colleague@acme.example", "someone@outside.example"] },
      { internalDomains: ["acme.example"] },
    );
    expect(signals.recipient_external).toBe(true);
  });

  it("stays silent when no recipient is a readable address", () => {
    // Opaque ids say nothing about which side of the perimeter they sit on.
    const signals = classifyAtEdge({ to: ["user_881"] }, { internalDomains: ["acme.example"] });
    expect(signals.recipient_external).toBeUndefined();
    expect(signals.recipient_count).toBe(1);
  });
});

describe("amount — never on an assumed unit", () => {
  it("is not emitted unless the unit is stated", () => {
    expect(classifyAtEdge({ amount: 1250 })).toEqual({});
  });

  it("passes a minor-unit value through", () => {
    const signals = classifyAtEdge({ amount: 1250 }, { amountInMinorUnits: true });
    expect(signals.amount).toBe(1250);
  });

  it("scales a major-unit value rather than shipping the wrong unit", () => {
    const signals = classifyAtEdge({ amount: 12.5 }, { amountInMinorUnits: false });
    expect(signals.amount).toBe(1250);
  });

  it("reads a numeric string", () => {
    const signals = classifyAtEdge({ price: "99.99" }, { amountInMinorUnits: false });
    expect(signals.amount).toBe(9999);
  });

  it("does not read ordinary words like `value` or `sum` as money", () => {
    // `settings.update({ key, value })` moves no money. Declaring 250000 here would put the call
    // over the bulk threshold with a `declared` magnitude, overriding Heron's derivation — a wrong
    // signal is worse than the `unknown` it replaces.
    const signals = classifyAtEdge(
      { key: "timeout_ms", value: 250000, sum: 900000 },
      { amountInMinorUnits: true },
    );

    expect(signals.amount).toBeUndefined();
  });

  it("reads a vendor's own field name when it names one", () => {
    const signals = classifyAtEdge(
      { order_total: 4200 },
      { amountInMinorUnits: true, fields: { amount: ["order_total"] } },
    );

    expect(signals.amount).toBe(4200);
  });
});

describe("the line it must not cross", () => {
  it("emits only signals the contract pins to the vendor's side", () => {
    // Every key it can produce must be one Heron cannot derive itself. A key with derivable "full"
    // showing up here would mean we shipped our own guess as the vendor's assertion.
    const produced = new Set<string>();
    const samples: Array<Record<string, unknown>> = [
      { to: ["a@x.example"], ids: [1, 2], amount: 10 },
      { recipient: "user_1", records: ["r"], total: "5" },
    ];
    for (const args of samples) {
      for (const key of Object.keys(
        classifyAtEdge(args, { internalDomains: ["acme.example"], amountInMinorUnits: true }),
      )) {
        produced.add(key);
      }
    }

    expect(produced.size).toBeGreaterThan(0);
    for (const key of produced) {
      expect(SIGNAL_KEYS[key as keyof typeof SIGNAL_KEYS].derivable).toBe("none");
    }
  });

  it("never asserts the operation, the data class or the reversibility", () => {
    // Heron derives all three from the tool name and publishes them as `derived`. Repainting that
    // guess `declared` would add no information and would defeat the signal-source counter.
    const signals = classifyAtEdge(
      { to: "victim@outside.example", amount: 5000, ids: [1] },
      { internalDomains: ["acme.example"], amountInMinorUnits: true },
    );
    expect(signals).not.toHaveProperty("op");
    expect(signals).not.toHaveProperty("data_class");
    expect(signals).not.toHaveProperty("reversible");
  });

  it("never asserts that a human approved anything", () => {
    const signals = classifyAtEdge({ to: "a@x.example", approver: "someone", human_decision: "APPROVE" });
    expect(signals).not.toHaveProperty("approver");
    expect(signals).not.toHaveProperty("human_decision");
    expect(signals).not.toHaveProperty("resolves_action");
  });
});

describe("it finds the keys where a platform actually puts them", () => {
  // Measured, not assumed: over a 30-day production window the guard emitted a signal on 0.8% of
  // calls. The conventional keys were there — one level down, inside a tool bus's envelope or a
  // message object — and nothing looked at them.
  it("reads through an envelope", () => {
    expect(classifyAtEdge({ params: { to: ["a@x.example", "b@y.example"] } })).toEqual({
      recipient_count: 2,
    });
  });

  it("counts recipients across a batch of objects", () => {
    // A list of messages, each with its own recipient, is the ordinary shape for exactly the fact
    // this classifier exists to count.
    expect(
      classifyAtEdge({ messages: [{ to: "a@x.example" }, { to: "b@y.example" }] }),
    ).toEqual({ recipient_count: 2 });
  });

  it("does not count a recipient list twice", () => {
    // The value found at a key is the answer for that key. Descending into it as well would count
    // the list once and its items again — a doubled `recipient_count` moves a call across the bulk
    // threshold, and a declared signal overrides Heron's derivation, so a wrong one is worse than
    // the `unknown` it replaces.
    expect(classifyAtEdge({ to: ["a@x.example", "b@y.example"] })).toEqual({ recipient_count: 2 });
  });

  it("finds records and an amount below the top level", () => {
    expect(
      classifyAtEdge({ body: { ids: [1, 2, 3] }, payment: { amount: 2500 } }, { amountInMinorUnits: true }),
    ).toEqual({ record_count: 3, amount: 2500 });
  });

  it("stops before it can be made to walk an arbitrary structure", () => {
    // The depth bound is a limit on our work on the hot path, never on what may be claimed: past it
    // the key is simply not found, which is the same honest silence as an argument that never had it.
    const deep = { a: { b: { c: { d: { e: { to: "buried@x.example" } } } } } };
    expect(classifyAtEdge(deep)).toEqual({});
  });
});

describe("a perimeter that is not a property of the process", () => {
  const call = { to: "someone@customer.example" };

  it("resolves the perimeter per call, from the context the guard passes", () => {
    // On a multi-tenant platform "internal" belongs to the customer whose agent is running, not to
    // the vendor. One global list declares the vendor's own staff internal to somebody else's agent
    // — and since the signal crosses as `declared`, that is a signed falsehood which also drops the
    // call out of the external-send rule that would otherwise have caught even `unknown`.
    const perimeters: Record<string, string[]> = {
      "tenant-a": ["customer.example"],
      "tenant-b": ["other.example"],
    };
    const internalDomains = (ctx: { principal?: { ref: string } }) =>
      perimeters[ctx.principal?.ref ?? ""];

    expect(
      classifyAtEdge(call, { internalDomains }, { tool: "gmail.send", principal: { type: "human", ref: "tenant-a" } }),
    ).toEqual({ recipient_count: 1, recipient_external: false });

    expect(
      classifyAtEdge(call, { internalDomains }, { tool: "gmail.send", principal: { type: "human", ref: "tenant-b" } }),
    ).toEqual({ recipient_count: 1, recipient_external: true });
  });

  it("claims nothing for a tenant it cannot resolve", () => {
    // `undefined` is the answer for "I do not know whose perimeter applies", and it must read as
    // silence rather than as "external": an unknown Heron can see beats a guess it cannot.
    const signals = classifyAtEdge(call, { internalDomains: () => undefined }, { tool: "gmail.send" });
    expect(signals).toEqual({ recipient_count: 1 });
  });

  it("still accepts a plain list for a single-tenant vendor", () => {
    expect(classifyAtEdge(call, { internalDomains: ["customer.example"] })).toEqual({
      recipient_count: 1,
      recipient_external: false,
    });
  });
});
