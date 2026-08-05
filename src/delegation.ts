import { hashCanonical } from "./crypto/hash";

/**
 * The job a run belongs to, and the authority it was given — the sending half.
 *
 * Two of the six questions a check needs answered had no field on Heron's wire at all: *what the
 * agent was allowed*, and *how a run links to other runs*. Heron reserved both at session open
 * (`src/lib/policy/delegation.ts` there); this is the side that fills them, and it is one file for the
 * same reason it is one file there — they are one reservation, made once, at the same moment.
 *
 * What crosses is digests. The task reference and the parent run's id are hashed into the session's
 * genesis record, so the run cannot restate afterwards which job it belonged to; the grant travels as
 * a digest over a document that stays here, exactly as the instruction slot does. Two runs belong to
 * one job when their digests match, which is all the linking ever needed.
 *
 * **Nothing here reaches a verdict, and nothing here should.** A grant is the audited party describing
 * its own limits, so a rule that turned on it would make omitting it the cheapest way to avoid the
 * rule. Heron counts how much of a window stated anything and does not count a breach: reaching beyond
 * a named set is a fact and not a fault — an agent that resolves a tool at runtime is doing its job.
 */

/**
 * The classes a grant may name, per dimension of Heron's classifier.
 *
 * Deliberately the classifier's own vocabulary rather than a delegation language of ours: these are
 * the values Heron already derives for every call, so "was this inside the grant?" is a comparison
 * between two things the published record holds, and not a second engine nobody can recompute.
 *
 * `unknown` is absent from every list on purpose. It is Heron's admission that it could not tell, not
 * a class of action a vendor can delegate, and naming it would turn its ignorance into your
 * permission. Heron refuses one with a 400.
 */
export interface GrantBounds {
  operation?: Array<"read" | "write" | "send" | "delete" | "execute">;
  data_class?: Array<"none" | "operational" | "financial" | "credential" | "personal">;
  destination?: Array<"none" | "internal" | "external" | "third_party">;
  magnitude?: Array<"none" | "single" | "bulk">;
  reversibility?: Array<"reversible" | "costly" | "terminal">;
}

/**
 * The machine-readable half of a delegation.
 *
 * Every field optional, and an absent field means *unbounded on that dimension* — never *empty*. An
 * empty list is refused at Heron's door for the same reason: `[]` cannot say whether you meant
 * "nothing is allowed" or "this is not bounded", the two are opposite, and a delegation is the last
 * document to guess in.
 */
export interface GrantScope {
  /** The tools this run was allowed to call. Absent: the grant does not bound the tool set. */
  allowedTools?: string[];
  /** Per dimension, the classes it was allowed to reach. Absent: unbounded there. */
  bounds?: GrantBounds;
  /** When the delegation lapses. Absent means you stated no expiry, which is not "never". */
  expiresAt?: Date | string;
}

/** What a run says it was allowed. */
export interface SessionGrant {
  /**
   * Your own delegation record — the policy, the ticket, the approval, whatever governs this run.
   *
   * The **document**, not a digest, for the reason `resolveStepUp({ shownText })` takes the text: the
   * hashing happens in one place that cannot be forgotten at a call site, and the document itself
   * never crosses. It is hashed with `hashCanonical` (RFC 8785), so an object is safe to pass — key
   * order will not decide whether you can reproduce the digest later.
   *
   * Unkeyed, unlike a confirmation prompt, and the difference is what the pre-image is: a delegation
   * document is your own configuration, so its digest sits with `instructions_hash` — published, and
   * safe to publish. A confirmation prompt is prose about a person, which is why *that* one is keyed.
   */
  document: unknown;
  /** A pointer into your own system. Opaque, never compared with anything, refused if it looks like an address. */
  ref?: string;
  /** The named set. Omit it and you have committed to the document and told a checker nothing. */
  scope?: GrantScope;
}

/** How this run links to other runs. */
export interface SessionTask {
  /**
   * The job several runs belong to, in your own namespace.
   *
   * Opaque: it is hashed, never interpreted, and never published — Heron shows a reviewer a number
   * local to the page. An address here is refused with a 400 rather than scrubbed, because a value
   * altered quietly would stop matching the one you sent, and two runs of one job would stop linking
   * for a reason invisible from both sides.
   */
  ref: string;
  /** The `external_id` of the run that spawned this one, where one did. */
  parentSessionExternalId?: string;
}

/** The wire shape Heron accepts for `task`. */
export interface TaskPayload {
  ref: string;
  parent_session_external_id?: string;
}

/** The wire shape Heron accepts for `grant`. */
export interface GrantPayload {
  hash: string;
  ref?: string;
  scope?: {
    allowed_tools?: string[];
    bounds?: GrantBounds;
    expires_at?: string;
  };
}

export function taskPayload(task: SessionTask | undefined): TaskPayload | undefined {
  if (!task) return undefined;
  return {
    ref: task.ref,
    ...(task.parentSessionExternalId
      ? { parent_session_external_id: task.parentSessionExternalId }
      : {}),
  };
}

/**
 * Reduce a grant to what crosses.
 *
 * The scope is mapped key by key and otherwise left alone — not sorted, not de-duplicated. Heron
 * digests it as it arrives, and you have to be able to reproduce that digest from your own record;
 * a set we tidied first could not be reproduced, for a reason invisible from your side.
 */
export function grantPayload(grant: SessionGrant | undefined): GrantPayload | undefined {
  if (!grant) return undefined;

  const scope = grant.scope;
  const expiresAt =
    scope?.expiresAt instanceof Date ? scope.expiresAt.toISOString() : scope?.expiresAt;

  return {
    hash: hashCanonical(grant.document),
    ...(grant.ref ? { ref: grant.ref } : {}),
    ...(scope
      ? {
          scope: {
            ...(scope.allowedTools ? { allowed_tools: scope.allowedTools } : {}),
            ...(scope.bounds ? { bounds: scope.bounds } : {}),
            ...(expiresAt ? { expires_at: expiresAt } : {}),
          },
        }
      : {}),
  };
}
