import { DomainError } from "../core/errors.js";
import type { AIUsage } from "../observability/usage.js";

/**
 * LlmProvider port: a single provider-agnostic seam for model calls.
 *
 * Every vendor is normalised into these shapes so that token and cost accounting
 * (§14, §15) works uniformly and no vendor type reaches the domain. Application
 * and domain code never import a vendor SDK: the only thing above this port is
 * `LlmProvider`, and the only thing below it is an adapter (ADR-022).
 *
 * Two honesty rules are encoded in the shape itself, not in documentation:
 *
 * - **`usage` is optional.** A provider that reports no usage produces `undefined`,
 *   never a fabricated zero, so "free" and "unknown" can never be confused (§5).
 * - **Failures are categorised, not narrated.** `LlmProviderError` carries a kind,
 *   a status code and an attempt count; the vendor's own message text stays out of
 *   both events and errors. See ADR-035.
 *
 * See V2-ARCHITECTURE §10.
 */
export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: string;
}

export interface LlmRequest {
  readonly modelId: string;
  readonly messages: readonly LlmMessage[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  /** Correlates the call with the task/session that caused it. */
  readonly correlationId: string;
}

export type LlmFinishReason =
  "stop" | "length" | "tool-call" | "content-filter" | "error";

/** Why a provider call failed. A closed set, so the log stays queryable. */
export const LLM_FAILURE_KINDS = [
  /** 401/403: credentials missing, invalid or not permitted. */
  "auth",
  /** 429: the provider asked us to slow down. */
  "rate-limit",
  /** No response within the configured budget. */
  "timeout",
  /** DNS, TLS or socket failure: the provider was never reached. */
  "network",
  /** 5xx: the provider failed to serve the request. */
  "server",
  /** A success response that did not have the expected shape. */
  "malformed-response",
  /** The provider declined to answer (content filter, policy refusal). */
  "refused",
  "unknown",
] as const;

export type LlmFailureKind = (typeof LLM_FAILURE_KINDS)[number];

/**
 * What a 2xx response actually carried, as structure only — never its text.
 *
 * Recorded alongside `malformed-response` so an operator can tell an empty
 * completion from a reasoning-only one without anyone logging content (ADR-035).
 * A closed set, so the log stays queryable.
 */
export const LLM_CONTENT_PRESENCE = [
  /** The payload had no `choices` array, or an empty one. */
  "no-choices",
  /** A choice existed, but its content was empty or whitespace. */
  "empty-content",
  /** The model spent its response on reasoning and produced no content. */
  "reasoning-only",
  /** Non-empty content was present (also the successful shape's state). */
  "usable-content",
  /** The body was not JSON, or had none of the expected shape. */
  "unparseable",
] as const;

export type LlmContentPresence = (typeof LLM_CONTENT_PRESENCE)[number];

export interface LlmFailureDetails {
  readonly failureKind: LlmFailureKind;
  readonly providerId: string;
  readonly modelId: string;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly statusCode?: number;
  /** What a 2xx body actually carried, when the failure is `malformed-response`. */
  readonly contentPresence?: LlmContentPresence;
  /** Provider-requested delay, honoured by the retry decorator within a cap. */
  readonly retryAfterMs?: number;
}

/**
 * A categorised provider failure.
 *
 * The constructor takes a message for operators, which callers MUST pass through
 * `redactSecretLikeValues` first. Nothing in this class is ever written to the
 * event log: events record the category and the counters, never the prose.
 */
export class LlmProviderError extends DomainError {
  readonly failureKind: LlmFailureKind;
  readonly providerId: string;
  readonly modelId: string;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly contentPresence?: LlmContentPresence;
  readonly retryAfterMs?: number;

  constructor(details: LlmFailureDetails, message: string) {
    super("PROVIDER_FAILURE", message, {
      providerId: details.providerId,
      modelId: details.modelId,
      failureKind: details.failureKind,
      statusCode: details.statusCode,
      retryable: details.retryable,
      attempts: details.attempts,
    });
    this.failureKind = details.failureKind;
    this.providerId = details.providerId;
    this.modelId = details.modelId;
    this.attempts = details.attempts;
    this.retryable = details.retryable;
    if (details.statusCode !== undefined) {
      this.statusCode = details.statusCode;
    }
    if (details.contentPresence !== undefined) {
      this.contentPresence = details.contentPresence;
    }
    if (details.retryAfterMs !== undefined) {
      this.retryAfterMs = details.retryAfterMs;
    }
  }
}

/** Retryable by transport, not by verdict: auth and malformed responses are not. */
export function isRetryableFailure(kind: LlmFailureKind): boolean {
  return (
    kind === "rate-limit" ||
    kind === "timeout" ||
    kind === "network" ||
    kind === "server"
  );
}

export function isLlmProviderError(value: unknown): value is LlmProviderError {
  return value instanceof LlmProviderError;
}

export interface LlmResponse {
  readonly modelId: string;
  readonly providerId: string;
  readonly content: string;
  readonly finishReason: LlmFinishReason;
  /**
   * Absent when the provider reported no usage. Callers must record that absence
   * rather than substituting zeroes (ADR-035).
   */
  readonly usage?: AIUsage;
  readonly latencyMs: number;
  /** Transport attempts spent on this call, including the successful one. */
  readonly attempts?: number;
  /** The provider's own request identifier, when it supplies one. */
  readonly requestId?: string;
}

export interface LlmProvider {
  readonly id: string;
  readonly models: readonly string[];
  complete(request: LlmRequest): Promise<LlmResponse>;
}
