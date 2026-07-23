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
  defineContract,
  derivedSessionStore,
  memorySessionStore,
} from "./vendor-guard";
export type {
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
  ReductionCtx,
  StepUpRequest,
  StepUpResolver,
  BlockedResult,
} from "./vendor-guard";

// The boundary contract: the one movable part of the seam, and its per-signal metadata.
export { SIGNAL_KEYS, SIGNAL_KEY_LIST } from "./contract";
export type { SignalKey, SignalSpec, SignalType, Derivable } from "./contract";

// The reference edge classifier: the arguments of a call, read for the facts pinned to your side.
// Optional and always overridable — a convenience implementation of the contract, not the contract.
export { classifyAtEdge } from "./edge-classify";
export type {
  EdgeClassifierOptions,
  EdgeFields,
  EdgeSignals,
} from "./edge-classify";

// Edge-side pseudonymisation: tokenise a recipient before it crosses, with the vendor's own key.
export { pseudonymWith, replaceAnchors, collectAnchors, ANCHOR_PATTERNS } from "./pseudonym-core";
export type { AnchorType } from "./pseudonym-core";

// The execution-evidence statement the vendor signs.
export { buildExecutionEvidencePayload } from "./statements";
export type { ExecutionEvidencePayload } from "./statements";
