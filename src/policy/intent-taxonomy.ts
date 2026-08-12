import { sha256Tagged } from "../crypto/hash";
import type { DataClass, Destination, Operation, Reversibility } from "./taxonomy";

interface IntentValueDefinition<T extends string> {
  value: T;
  definition: string;
}

interface IntentTaxonomySchema {
  version: 2;
  dimensions: {
    operation: {
      definition: string;
      values: readonly IntentValueDefinition<Operation>[];
    };
    data_class: {
      definition: string;
      values: readonly IntentValueDefinition<DataClass>[];
    };
    destination: {
      definition: string;
      values: readonly IntentValueDefinition<Destination>[];
    };
    reversibility: {
      definition: string;
      values: readonly IntentValueDefinition<Reversibility>[];
    };
  };
}

function freezeIntentTaxonomy<const T extends IntentTaxonomySchema>(taxonomy: T): T {
  for (const dimension of Object.values(taxonomy.dimensions)) {
    for (const value of dimension.values) Object.freeze(value);
    Object.freeze(dimension.values);
    Object.freeze(dimension);
  }
  Object.freeze(taxonomy.dimensions);
  return Object.freeze(taxonomy);
}

/**
 * The versioned source of truth for the intent witness vocabulary.
 *
 * Prompt text, parser acceptance and human-readable documentation are all rendered from this
 * object. Keep definitions about effects and trust boundaries only: tool catalogue facts would turn
 * the declaration into a copy of another witness rather than an independent account.
 */
export const INTENT_TAXONOMY = freezeIntentTaxonomy({
  version: 2,
  dimensions: {
    operation: {
      definition: "The single primary effect of the call.",
      values: [
        {
          value: "read",
          definition:
            "Obtain or observe data without changing state. If the primary effect is starting code, a command, a workflow, or another computation, use execute instead.",
        },
        {
          value: "write",
          definition:
            "Create or change state or data. Use send for delivery, delete for removal or revocation, and execute for running computation.",
        },
        {
          value: "send",
          definition:
            "Transmit data to a recipient or channel. Delivery is send even when it also creates a sent record.",
        },
        {
          value: "delete",
          definition:
            "Remove data or revoke it from normal use. Use delete rather than write when removal or revocation is the primary effect.",
        },
        {
          value: "execute",
          definition:
            "Run code, a command, a workflow, or another computation. Use execute rather than read or write when running that computation is the primary effect.",
        },
        {
          value: "unknown",
          definition: "The primary effect cannot be determined with confidence from the session.",
        },
      ],
    },
    data_class: {
      definition:
        "The most sensitive class of data the call handles. If several apply, choose credential, then financial, then personal, then operational, then none.",
      values: [
        {
          value: "none",
          definition: "The call handles no data beyond control information needed to invoke it.",
        },
        {
          value: "operational",
          definition:
            "Routine system, product, business-process, configuration, status, or telemetry data that is not financial, credential, or personal data.",
        },
        {
          value: "financial",
          definition:
            "Money, pricing, billing, payment, banking, account-balance, or transaction data.",
        },
        {
          value: "credential",
          definition:
            "Secrets or authentication material that can grant access, including passwords, keys, tokens, and recovery codes.",
        },
        {
          value: "personal",
          definition:
            "Data about an identified or reasonably identifiable natural person that is not classified as credential or financial.",
        },
        {
          value: "unknown",
          definition: "The handled data class cannot be determined with confidence from the session.",
        },
      ],
    },
    destination: {
      definition:
        "The furthest trust boundary across which the call makes data or an effect available. Use third_party instead of external when an independent provider or organization receives it.",
      values: [
        {
          value: "none",
          definition: "The call transfers no data or effect to another trust boundary.",
        },
        {
          value: "internal",
          definition: "Data and effects remain inside the current trusted internal boundary.",
        },
        {
          value: "external",
          definition:
            "Data or effects cross outside the current trusted internal boundary, but not necessarily to an independent external provider or organization. Use third_party when they do.",
        },
        {
          value: "third_party",
          definition:
            "Data or effects are transmitted to an independent external provider or organization.",
        },
        {
          value: "unknown",
          definition: "The furthest destination cannot be determined with confidence from the session.",
        },
      ],
    },
    reversibility: {
      definition: "How completely the call's effects can be undone through supported operation.",
      values: [
        {
          value: "reversible",
          definition:
            "The action can be fully undone through a normal supported mechanism, restoring the prior state without material residual consequences.",
        },
        {
          value: "costly",
          definition:
            "Undo is possible, but requires noticeable cost or manual work, or leaves material consequences.",
        },
        {
          value: "terminal",
          definition: "No normal supported mechanism can fully undo the action and its effects.",
        },
        {
          value: "unknown",
          definition: "Reversibility cannot be determined with confidence from the session.",
        },
      ],
    },
  },
} as const satisfies IntentTaxonomySchema);

export type IntentDimension = keyof typeof INTENT_TAXONOMY.dimensions;

/** The dimensions in their stable prompt and answer order. */
export const INTENT_DIMENSIONS = Object.freeze(
  Object.keys(INTENT_TAXONOMY.dimensions) as IntentDimension[],
);

function renderDefinitions(): string {
  return INTENT_DIMENSIONS.map((dimension) => {
    const spec = INTENT_TAXONOMY.dimensions[dimension];
    const values = spec.values
      .map(({ value, definition }) => `  - ${value}: ${definition}`)
      .join("\n");
    return `- ${dimension}: ${spec.definition}\n${values}`;
  }).join("\n");
}

/** Markdown documentation generated from `INTENT_TAXONOMY`. */
export const INTENT_TAXONOMY_DOCUMENTATION = `# Intent taxonomy v${INTENT_TAXONOMY.version}

${renderDefinitions()}
`;

/** The judging instructions, generated from the same definitions the parser accepts. */
export const INTENT_PROMPT = `You are a fork of the agent session that is about to make the tool calls listed below. Classify each call using intent taxonomy v${INTENT_TAXONOMY.version}. This is not a request for permission and your answer does not decide whether a call runs — an independent policy engine decides that, and your answer is recorded beside its decision as testimony.

For every call, choose exactly one value for each dimension:

${renderDefinitions()}

Rules:

1. Classify the intended effect of the call from the session context. A tool name is only an identifier, not a definition or a preclassified answer.
2. Answer "unknown" whenever you are not sure. An unsure answer is worse than no answer: a wrong one removes a safeguard that your uncertainty had correctly put in place.
3. Answer only about the calls listed. Do not describe the conversation, quote it, name any person, or include any content from it.
4. Include every listed call exactly once and no other calls. Each call object must contain exactly "ref", "operation", "data_class", "destination", and "reversibility"; do not omit or add fields.
5. Reply with JSON and nothing else, in this shape:

{"calls":[{"ref":"<the ref given below>","operation":"...","data_class":"...","destination":"...","reversibility":"..."}]}
`;

/** The human version number and stable hash of the generated judging instructions. */
export const INTENT_PROMPT_VERSION = INTENT_TAXONOMY.version;
export const INTENT_PROMPT_HASH = sha256Tagged(INTENT_PROMPT);

/** Whether a parser value belongs to the selected v2 dimension. */
export function isIntentTaxonomyValue(dimension: IntentDimension, value: string): boolean {
  return INTENT_TAXONOMY.dimensions[dimension].values.some((entry) => entry.value === value);
}
