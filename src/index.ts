/**
 * @theonaai/heron-sdk — public surface.
 *
 * The vendor side of Heron: one hook before every agent tool call, one signed statement after it.
 * Framework-agnostic and free of any server dependency — the only runtime dependencies are
 * `@noble/hashes` and `@noble/ed25519`. `tests/sdk-portable.test.ts` holds the import graph
 * server-free (no database, no `node:*`), which is what lets this package run wherever the vendor
 * runs. The app that operates Heron consumes these same modules back through this package's subpath
 * exports — this repository is the single source of truth for the signed-bytes core.
 */

// Transport + signing: the four calls a cooperating vendor makes, and the verdict helper.
export {
  HeronClient,
  HeronUnavailableError,
  hashResult,
  mayExecute,
} from "./vendor-sdk";
export type {
  HeronClientOptions,
  CircuitBreakerOptions,
  BeforeActionResult,
  ExecutionOutcome,
} from "./vendor-sdk";

// The guard: the integration loop, made declarative. Wrap tools, they honour verdicts.
export {
  openGuardedSession,
  reduce,
  resolveContract,
  defineContract,
  derivedSessionStore,
  memorySessionStore,
} from "./vendor-guard";
export type {
  InstructionSignals,
  ToolContract,
  ContractMap,
  GuardedCall,
  GuardedTool,
  GuardClient,
  GuardOptions,
  GuardedSession,
  GuardDecision,
  SessionStore,
  ResolvedCall,
  CallResolver,
  Signals,
  SignalValue,
  ApprovalSignals,
  InferenceSignals,
  ReductionCtx,
  StepUpRequest,
  StepUpResolver,
  BlockedResult,
} from "./vendor-guard";

// The boundary contract: the one movable part of the seam, and its per-signal metadata.
export {
  SIGNAL_KEYS,
  SIGNAL_KEY_LIST,
  formatInferredDimensions,
  parseInferredDimensions,
} from "./contract";
export type { SignalKey, SignalSpec, SignalType, Derivable } from "./contract";

// The reference edge classifier: the arguments of a call, read for the facts pinned to your side.
// Optional and always overridable — a convenience implementation of the contract, not the contract.
export { classifyAtEdge } from "./edge-classify";
export type {
  EdgeClassifierOptions,
  EdgeContext,
  EdgeFields,
  EdgeSignals,
} from "./edge-classify";

// The fork: ask your own model what it is about to do, and send the answer marked as testimony.
// The question is ours and versioned; the asking is yours, because the session and the bill are.
export {
  INTENT_DIMENSIONS,
  INTENT_PROMPT,
  INTENT_PROMPT_HASH,
  INTENT_PROMPT_VERSION,
  buildIntentQuestion,
  intentSignals,
  parseIntentAnswer,
  stripMeasured,
} from "./policy/intent";
export type {
  IntentAsker,
  IntentCall,
  IntentClaim,
  IntentDimension,
  IntentOptions,
  IntentQuestion,
  IntentSignals,
  IntentSlice,
} from "./policy/intent";

// The commitment to the agent's own governing text — inert by construction, and the only thing that
// makes a mid-session rewrite of the system prompt visible at all.
export { INSTRUCTIONS_SIGNAL, instructionsHash } from "./instructions";

// Edge-side pseudonymisation: tokenise a recipient before it crosses, with the vendor's own key.
export { pseudonymWith, replaceAnchors, collectAnchors, ANCHOR_PATTERNS } from "./pseudonym-core";
export type { AnchorType } from "./pseudonym-core";

// The execution-evidence statement the vendor signs.
export { buildExecutionEvidencePayload } from "./statements";
export type { ExecutionEvidencePayload } from "./statements";

// The tool catalogue: what each tool *is*, signed once and published — so a classification does not
// have to be inferred from a name the vendor chose.
export { CATALOG_SIGNAL_KEYS, buildToolCatalog, catalogHash, resolveCatalogEntry } from "./tool-catalog";
export type {
  CatalogEntry,
  CatalogSignalKey,
  CatalogSignals,
  ToolCatalog,
} from "./tool-catalog";
