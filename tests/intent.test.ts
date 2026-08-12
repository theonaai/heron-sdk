import { describe, expect, it } from "vitest";

import {
  INTENT_DIMENSIONS,
  INTENT_PROMPT,
  INTENT_PROMPT_HASH,
  INTENT_PROMPT_VERSION,
  INTENT_TAXONOMY,
  INTENT_TAXONOMY_DOCUMENTATION,
  buildIntentQuestion,
  intentSignals,
  parseIntentAnswer,
  stripMeasured,
} from "../src/policy/intent";
import { sha256Tagged } from "../src/crypto/hash";
import * as publicApi from "../src/index";
import { type GuardClient, openGuardedSession } from "../src/vendor-guard";

/**
 * The fork asks a witness that shares the attacker's channel, so nothing here may rest on believing
 * it. These tests pin the four properties that make the answer safe to send at all: the question is
 * ours, an unreadable answer is silence rather than a guess, a claim never displaces a measurement,
 * and no answer a model can give reaches a human gate.
 */

const witness = { model: "claude-sonnet-5", slice: "last_turn" as const };

describe("the question put to the fork", () => {
  it("has exactly the v2 dimensions and values", () => {
    expect(INTENT_PROMPT_VERSION).toBe(2);
    expect(Object.isFrozen(INTENT_TAXONOMY)).toBe(true);
    expect(Object.isFrozen(INTENT_TAXONOMY.dimensions.operation.values)).toBe(true);
    expect(INTENT_DIMENSIONS).toEqual([
      "operation",
      "data_class",
      "destination",
      "reversibility",
    ]);
    expect(
      Object.fromEntries(
        INTENT_DIMENSIONS.map((dimension) => [
          dimension,
          INTENT_TAXONOMY.dimensions[dimension].values.map(({ value }) => value),
        ]),
      ),
    ).toEqual({
      operation: ["read", "write", "send", "delete", "execute", "unknown"],
      data_class: ["none", "operational", "financial", "credential", "personal", "unknown"],
      destination: ["none", "internal", "external", "third_party", "unknown"],
      reversibility: ["reversible", "costly", "terminal", "unknown"],
    });
  });

  it("defines every dimension and value in both the prompt and generated documentation", () => {
    for (const dimension of INTENT_DIMENSIONS) {
      const spec = INTENT_TAXONOMY.dimensions[dimension];
      expect(spec.definition.length).toBeGreaterThan(0);
      expect(INTENT_PROMPT).toContain(`- ${dimension}: ${spec.definition}`);
      expect(INTENT_TAXONOMY_DOCUMENTATION).toContain(`- ${dimension}: ${spec.definition}`);
      for (const { value, definition } of spec.values) {
        expect(definition.length).toBeGreaterThan(0);
        expect(INTENT_PROMPT).toContain(`  - ${value}: ${definition}`);
        expect(INTENT_TAXONOMY_DOCUMENTATION).toContain(`  - ${value}: ${definition}`);
      }
    }
  });

  it("does not treat the control query for an ordinary external read as an outbound destination", () => {
    const definitions = Object.fromEntries(
      INTENT_TAXONOMY.dimensions.destination.values.map(({ value, definition }) => [
        value,
        definition,
      ]),
    );

    expect(INTENT_TAXONOMY.dimensions.destination.definition).toContain(
      "meaningful payload or effect",
    );
    expect(definitions.none).toContain("ordinary read");
    expect(definitions.none).toContain("control or query material");
    expect(definitions.external).toContain("meaningful payload or effect");
    expect(definitions.external).toContain("outbound send, write");
    expect(definitions.third_party).toContain("meaningful payload or effect");
    expect(definitions.third_party).toContain("outbound send, write");
  });

  it("separates costly recovery from an effect that cannot be recalled or restored", () => {
    const definitions = Object.fromEntries(
      INTENT_TAXONOMY.dimensions.reversibility.values.map(({ value, definition }) => [
        value,
        definition,
      ]),
    );

    expect(definitions.costly).toContain("business state can still be restored");
    expect(definitions.costly).toContain("audit trail");
    expect(definitions.terminal).toContain("cannot be recalled");
    expect(definitions.terminal).toContain("cannot be restored");
  });

  it("contains no tool-specific definitions or preclassified answers", () => {
    expect(INTENT_PROMPT).not.toMatch(/gmail|slack|stripe|attio|apollo|catalogue/i);
    expect(INTENT_TAXONOMY_DOCUMENTATION).not.toMatch(
      /gmail|slack|stripe|attio|apollo|catalogue/i,
    );

    const question = buildIntentQuestion([{ ref: "call_1", name: "opaque.tool" }]);
    expect(question.prompt.startsWith(`${INTENT_PROMPT}\nCalls:\n\n`)).toBe(true);
    expect(question.prompt.match(/opaque\.tool/g)).toHaveLength(1);
  });

  it("hashes to a constant a reviewer can look up, and changes only with the version", () => {
    // Golden, on purpose. `inference_prompt_hash` is worth something only if it identifies one
    // published set of bytes; a hash that drifts with an editing pass would be provenance nobody can
    // resolve, and every receipt already in the field would name a question that no longer exists.
    // If this fails, the prompt changed: bump INTENT_PROMPT_VERSION and update the constant here.
    expect(INTENT_PROMPT_HASH).toBe(
      "sha256:db51b38e1457e36c9c3c20d56386370a4d91aa8ef49805d98a60d38adb37f37c",
    );
    expect(INTENT_PROMPT_HASH).toBe(sha256Tagged(INTENT_PROMPT));
    expect(buildIntentQuestion([]).promptHash).toBe(INTENT_PROMPT_HASH);
    expect(buildIntentQuestion([]).prompt).toBe(`${INTENT_PROMPT}\nCalls:\n\n\n`);
  });

  it("names the calls and nothing about them but their tool", () => {
    const question = buildIntentQuestion([
      { ref: "call_1", name: "gmail.send" },
      { ref: "call_2", name: "crm.get_customer" },
    ]);

    expect(question.promptHash).toBe(INTENT_PROMPT_HASH);
    expect(question.prompt).toContain("ref: call_1 — tool: gmail.send");
    expect(question.prompt).toContain("ref: call_2 — tool: crm.get_customer");
  });

  it("never asks about magnitude", () => {
    // Its signals are counts, and a count is a measurement `classifyAtEdge` reads off the arguments.
    // Asking a model for one would dress an estimate as an observation in the single dimension a
    // reviewer reads as exact.
    expect(INTENT_DIMENSIONS).not.toContain("magnitude");
    expect(buildIntentQuestion([{ ref: "c", name: "t" }]).prompt).not.toContain("magnitude");
    expect(INTENT_TAXONOMY_DOCUMENTATION).not.toContain("magnitude");
  });
});

describe("reading the model's answer", () => {
  const refs = ["call_1"];
  const validCall = (overrides: Record<string, string> = {}) => ({
    ref: "call_1",
    operation: "send",
    data_class: "personal",
    destination: "external",
    reversibility: "terminal",
    ...overrides,
  });

  it("keeps a well-formed claim", () => {
    const claims = parseIntentAnswer(
      JSON.stringify({
        calls: [validCall()],
      }),
      refs,
    );

    expect(claims).toEqual([
      {
        ref: "call_1",
        dimensions: {
          operation: "send",
          data_class: "personal",
          destination: "external",
          reversibility: "terminal",
        },
      },
    ]);
  });

  it("accepts the wrappings models actually emit", () => {
    const row = JSON.stringify(validCall({ operation: "read" }));
    const fenced = `\`\`\`json\n{"calls":[${row}]}\n\`\`\``;
    const bare = `[${row}]`;

    expect(parseIntentAnswer(fenced, refs)).toHaveLength(1);
    expect(parseIntentAnswer(bare, refs)).toHaveLength(1);
  });

  it("rejects missing, extra, and unsupported values instead of partially accepting them", () => {
    const missing = validCall();
    delete (missing as Partial<typeof missing>).reversibility;

    expect(parseIntentAnswer(JSON.stringify({ calls: [missing] }), refs)).toEqual([]);
    expect(
      parseIntentAnswer(JSON.stringify({ calls: [{ ...validCall(), confidence: "high" }] }), refs),
    ).toEqual([]);
    expect(
      parseIntentAnswer(
        JSON.stringify({ calls: [validCall({ operation: "exfiltrate" })] }),
        refs,
      ),
    ).toEqual([]);
  });

  it("accepts taxonomy `unknown` as a decline for that dimension", () => {
    const claims = parseIntentAnswer(
      JSON.stringify({
        calls: [validCall({ operation: "unknown", data_class: "unknown" })],
      }),
      refs,
    );

    expect(claims).toEqual([
      {
        ref: "call_1",
        dimensions: { destination: "external", reversibility: "terminal" },
      },
    ]);
  });

  it("requires selected refs, rejects duplicates, and permits selecting from a whole-turn answer", () => {
    expect(parseIntentAnswer(JSON.stringify({ calls: [] }), refs)).toEqual([]);
    expect(
      parseIntentAnswer(JSON.stringify({ calls: [validCall({ ref: "call_9" })] }), refs),
    ).toEqual([]);

    const selected = parseIntentAnswer(
      JSON.stringify({ calls: [validCall(), { ...validCall(), ref: "call_2" }] }),
      refs,
    );
    expect(selected).toEqual([
      {
        ref: "call_1",
        dimensions: {
          operation: "send",
          data_class: "personal",
          destination: "external",
          reversibility: "terminal",
        },
      },
    ]);

    expect(
      parseIntentAnswer(
        JSON.stringify({ calls: [validCall(), validCall({ operation: "delete" })] }),
        refs,
      ),
    ).toEqual([]);
  });

  it("produces nothing at all from an answer it cannot read", () => {
    expect(parseIntentAnswer("I think this one is fine!", refs)).toEqual([]);
    expect(parseIntentAnswer("", refs)).toEqual([]);
    expect(parseIntentAnswer(null, refs)).toEqual([]);
  });
});

describe("the public API", () => {
  it("keeps the v1 exports and adds the generated v2 taxonomy documentation", () => {
    expect(publicApi.INTENT_DIMENSIONS).toBe(INTENT_DIMENSIONS);
    expect(publicApi.INTENT_PROMPT).toBe(INTENT_PROMPT);
    expect(publicApi.INTENT_PROMPT_HASH).toBe(INTENT_PROMPT_HASH);
    expect(publicApi.INTENT_PROMPT_VERSION).toBe(2);
    expect(publicApi.INTENT_TAXONOMY).toBe(INTENT_TAXONOMY);
    expect(publicApi.INTENT_TAXONOMY_DOCUMENTATION).toBe(INTENT_TAXONOMY_DOCUMENTATION);
  });
});

describe("a claim, as signals", () => {
  it("carries its values, the marking and the whole witness", () => {
    const signals = intentSignals({ dimensions: { destination: "external" } }, witness);

    expect(signals).toEqual({
      destination: "external",
      inferred: "destination",
      inference_model: "claude-sonnet-5",
      inference_prompt_hash: INTENT_PROMPT_HASH,
      inference_slice: "last_turn",
    });
  });

  it("emits nothing for a claim with nothing in it", () => {
    // A witness marking no dimension is provenance for a non-answer, and Heron refuses it at the
    // door — in both directions, so the partial form cannot be sent by accident either.
    expect(intentSignals({ dimensions: {} }, witness)).toEqual({});
  });

  it("cannot mark an approval, in any spelling", () => {
    const claims = parseIntentAnswer(
      JSON.stringify({
        calls: [
          {
            ref: "call_1",
            operation: "delete",
            data_class: "operational",
            destination: "internal",
            reversibility: "reversible",
            human_decision: "APPROVE",
            approver: "op_1",
          },
        ],
      }),
      ["call_1"],
    );

    // Extra fields invalidate the v2 row, so there is no answer a model can give that signs off on
    // its own step-up. Approval remains outside the declaration vocabulary entirely.
    expect(claims).toEqual([]);
  });
});

describe("a claim yields to a measurement, before it is sent", () => {
  const claim = intentSignals(
    { dimensions: { operation: "read", destination: "internal" } },
    witness,
  );

  it("drops a dimension the same key already measured", () => {
    const kept = stripMeasured(claim, { destination: "third_party" });

    // The measurement stays untouched (it is merged over this), and what leaves is a claim about the
    // dimension nobody measured — with the marking re-derived, so the witness never outlives it.
    expect(kept).toMatchObject({ op: "read", inferred: "operation" });
    expect(kept).not.toHaveProperty("destination");
  });

  it("drops a dimension a *different* key measured", () => {
    // `recipient_external` feeds destination just as `destination` does. Checking per key instead of
    // per dimension would let a model's `destination` ride over a contract that had already stated
    // the perimeter — the same fact, asserted twice, with the weaker one winning by spelling.
    const kept = stripMeasured(claim, { recipient_external: true });

    expect(kept).not.toHaveProperty("destination");
    expect(kept.inferred).toBe("operation");
  });

  it("emits nothing when every claimed dimension was measured", () => {
    expect(stripMeasured(claim, { op: "delete", destination: "external" })).toEqual({});
  });

  it("ignores a key whose value is absent", () => {
    // An undefined entry is a contributor that chose not to speak, not a measurement.
    expect(stripMeasured(claim, { destination: undefined })).toMatchObject({
      destination: "internal",
    });
  });
});

describe("the fork, through a guarded turn", () => {
  function session(opts: {
    ask?: (question: { prompt: string }) => Promise<string | null>;
    contracts?: Record<string, unknown>;
  }) {
    const sent: Array<Record<string, unknown> | undefined> = [];
    const heron = {
      anchor: (_t: string, v: string) => `tok_${v.length}`,
      openSession: async () => ({ session_id: "ses_1", chain: { genesis_hash: "sha256:0" } }),
      beforeAction: async (input: { signals?: Record<string, unknown> }) => {
        sent.push(input.signals);
        return {
          action_id: `act_${sent.length}`,
          decision: { decision_id: "dec_1", engine: "rules", verdict: "ALLOW" },
          receipt: { id: "rcp_1", kid: "hk", alg: "Ed25519", signature: "sig" },
          chain: { prev_hash: "sha256:0", record_hash: "sha256:1" },
        };
      },
      execution: async () => ({ ok: true }),
      closeSession: async () => ({ ok: true }),
    } as unknown as GuardClient;

    return {
      sent,
      open: () =>
        openGuardedSession({
          heron,
          contracts: (opts.contracts ?? {}) as never,
          agent: { externalId: "agent_1" },
          principal: { type: "human", ref: "user_1" },
          request: "email maria the invoice",
          sessionExternalId: "chat_1",
          edge: false,
          intent: opts.ask
            ? { ask: opts.ask as never, model: "claude-sonnet-5", slice: "last_turn" }
            : undefined,
        }),
    };
  }

  it("asks once for the turn and hands each call the claim about itself", async () => {
    let asked = 0;
    const harness = session({
      ask: async () => {
        asked += 1;
        return JSON.stringify({
          calls: [
            {
              ref: "c1",
              operation: "unknown",
              data_class: "unknown",
              destination: "external",
              reversibility: "unknown",
            },
            {
              ref: "c2",
              operation: "unknown",
              data_class: "unknown",
              destination: "internal",
              reversibility: "unknown",
            },
          ],
        });
      },
    });
    const guarded = await harness.open();

    const decisions = await guarded.decideTurn([
      { id: "c1", name: "gmail.send", args: {} },
      { id: "c2", name: "slack.post", args: {} },
    ]);

    // One completion for the whole turn — the property the cost argument rests on.
    expect(asked).toBe(1);
    expect(decisions.map((d) => d.kind)).toEqual(["run", "run"]);
    expect(harness.sent[0]).toMatchObject({
      destination: "external",
      inferred: "destination",
      inference_model: "claude-sonnet-5",
      inference_slice: "last_turn",
    });
    expect(harness.sent[1]).toMatchObject({ destination: "internal" });
  });

  it("decides the turn anyway when the fork throws", async () => {
    const harness = session({
      ask: async () => {
        throw new Error("the model is down");
      },
    });
    const guarded = await harness.open();

    const decisions = await guarded.decideTurn([{ id: "c1", name: "gmail.send", args: {} }]);

    // Failing to silence is the whole rule: a claim only ever fills a dimension nothing else
    // answered, so its absence leaves the dimension unknown and the friction in place. A fork that
    // could take a verdict down would have made the safety feature an outage.
    expect(decisions[0]!.kind).toBe("run");
    expect(harness.sent[0]).toBeUndefined();
  });

  it("lets the contract's measurement win, and sends no marking for it", async () => {
    const harness = session({
      ask: async () =>
        '[{"ref":"c1","operation":"unknown","data_class":"unknown","destination":"internal","reversibility":"unknown"}]',
      contracts: { "gmail.send": { signals: () => ({ recipient_external: true }) } },
    });
    const guarded = await harness.open();

    await guarded.decideTurn([{ id: "c1", name: "gmail.send", args: {} }]);

    // The measurement crosses untouched, the model's contradicting value never leaves this process,
    // and — because nothing else was claimed — no witness travels either. Heron cannot report a
    // contradiction it was never shown, so the yielding has to happen here as well as there.
    expect(harness.sent[0]).toEqual({ recipient_external: true });
  });

  it("asks nobody when no fork is configured", async () => {
    const harness = session({});
    const guarded = await harness.open();

    const decisions = await guarded.decideTurn([{ id: "c1", name: "crm.get_customer", args: {} }]);

    expect(decisions[0]!.kind).toBe("run");
    expect(harness.sent[0]).toBeUndefined();
  });
});
