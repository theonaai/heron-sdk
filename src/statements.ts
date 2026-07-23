/**
 * The vendor's signed statement of what it executed (§5.3) — the bytes both sides agree on.
 *
 * Pure and dependency-free on purpose: this is imported by the vendor SDK (src/lib/vendor-sdk.ts),
 * which must be publishable as a standalone package. It used to live in src/lib/receipts.ts, but
 * receipts.ts reaches for `keys` and `env` (and thereby Prisma) to sign *our* receipts — pulling
 * that whole chain into a client SDK. The execution-evidence payload needs none of it: it is the
 * shape the vendor canonicalizes and signs with its own key, so it belongs on its own.
 */
export interface ExecutionEvidencePayload {
  action_id: string;
  decision_id: string;
  outcome: string;
  result_hash: string | null;
  error_code: string | null;
  executed_at: string;
}

export function buildExecutionEvidencePayload(input: {
  actionId: string;
  decisionId: string;
  outcome: string;
  resultHash: string | null;
  errorCode: string | null;
  executedAt: string;
}): ExecutionEvidencePayload {
  return {
    action_id: input.actionId,
    decision_id: input.decisionId,
    outcome: input.outcome,
    result_hash: input.resultHash,
    error_code: input.errorCode,
    executed_at: input.executedAt,
  };
}
