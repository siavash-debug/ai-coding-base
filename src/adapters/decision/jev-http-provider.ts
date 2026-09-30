import type { Clock } from "../../core/clock.js";
import { durationMsFrom, toIsoString } from "../../core/clock.js";
import { assertNonEmptyString } from "../../core/validation.js";
import { assertValidUsage, type AIUsage } from "../../observability/usage.js";
import {
  MAX_DECISION_TOKEN_CHARS,
  isReasonCode,
} from "../../decisions/domains.js";
import {
  DECISION_FAILURE_KINDS,
  type DecisionFailureKind,
  type DecisionProviderResult,
  type DecisionRequest,
  type DecisionResponse,
  type UsageReportingDecisionProvider,
  DecisionProviderError,
} from "../../decisions/provider.js";
import type { Environment } from "../../ports/environment.js";
import {
  type HttpTransport,
  isHttpTransportError,
} from "../../ports/http-transport.js";

/**
 * The one real decision provider: JEV behind the `DecisionProvider` port.
 *
 * This is the Phase G equivalent of the Phase D LLM adapter, and it follows the same
 * discipline for the same reasons:
 *
 * - **A protocol, not a vendor.** The adapter speaks a small, documented JSON
 *   contract (`POST {baseUrl}/decide`). A JEV deployment implements that contract;
 *   the platform takes no position on how. Nothing JEV-specific leaves this file —
 *   `DecisionRequest` and `DecisionResponse` are the only shapes the application ever
 *   sees (ADR-051).
 * - **Credentials are referenced, never stored.** The configuration names an
 *   environment variable; the value is read through the `Environment` port at call
 *   time, used for one header, and dropped. A missing credential fails *before* any
 *   network call, and the message names the variable, never the value.
 * - **Nothing it says is trusted.** The adapter parses and shape-checks the payload;
 *   vocabulary, candidate membership and outcome legality are checked again by the
 *   deterministic validator. Free-text fields are read only to be discarded — the
 *   platform records reason *codes*, so provider prose cannot enter the event log.
 * - **Failures are categorised, not narrated.** Every failure becomes a
 *   `DecisionProviderError` with a category from the shared provider taxonomy. The
 *   provider's message, headers and body are never included.
 * - **Usage is optional and honest.** A response without usage yields no usage, which
 *   downstream accounting reports as unavailable rather than as zero (ADR-035).
 *
 * The transport is injected, so every behaviour below is testable with deterministic
 * fixtures, no network and no credential.
 */
export const JEV_PROVIDER_ID = "jev";
export const JEV_FAMILY = "jev" as const;
export const DEFAULT_JEV_TIMEOUT_MS = 15_000;

/** Bounds. A decision request is a summary; a decision response is a small object. */
export const MAX_JEV_REQUEST_CHARS = 8_192;
export const MAX_JEV_RESPONSE_CHARS = 65_536;
export const MAX_JEV_RANKED_IDS = 32;

export interface JevHttpProviderOptions {
  /** Decision service root, e.g. `https://jev.internal/v1`. Trailing slash tolerated. */
  readonly baseUrl: string;
  /** Name of the environment variable holding the credential. Never the key. */
  readonly credentialEnvVar: string;
  readonly environment: Environment;
  readonly transport: HttpTransport;
  readonly clock: Clock;
  readonly timeoutMs?: number;
  /** Optional provider-side model or version identifier, recorded with usage. */
  readonly modelId?: string;
  readonly id?: string;
}

/**
 * HTTP status to failure category.
 *
 * Deliberately the same mapping the LLM adapter uses, kept local because adapters do
 * not import each other (ADR-022). A test asserts the two agree for every status, so
 * they cannot drift apart silently.
 */
export function classifyDecisionStatus(status: number): DecisionFailureKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 408) {
    return "timeout";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status >= 500) {
    return "server";
  }
  if (status === 404) {
    // No decision endpoint at this address is "there is no decision layer here",
    // which is a configuration problem rather than a bad request.
    return "unavailable";
  }
  return "unknown";
}

function isRetryableDecisionFailure(kind: DecisionFailureKind): boolean {
  return (
    kind === "rate-limit" ||
    kind === "timeout" ||
    kind === "network" ||
    kind === "server"
  );
}

interface JevWireResponse {
  readonly outcome?: unknown;
  readonly optionId?: unknown;
  readonly rankedOptionIds?: unknown;
  readonly reasonCode?: unknown;
  readonly confidence?: unknown;
  readonly model?: unknown;
  readonly requestId?: unknown;
  readonly usage?: unknown;
}

function shortToken(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_DECISION_TOKEN_CHARS) {
    throw new Error(`${field} exceeds ${MAX_DECISION_TOKEN_CHARS} characters`);
  }
  return value;
}

export function createJevHttpProvider(
  options: JevHttpProviderOptions,
): UsageReportingDecisionProvider {
  const providerId = options.id ?? JEV_PROVIDER_ID;
  const baseUrl = assertNonEmptyString(options.baseUrl, "baseUrl").replace(
    /\/+$/,
    "",
  );
  const credentialEnvVar = assertNonEmptyString(
    options.credentialEnvVar,
    "credentialEnvVar",
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;

  function fail(
    failureKind: DecisionFailureKind,
    details: { statusCode?: number } = {},
  ): never {
    throw new DecisionProviderError(
      {
        failureKind,
        providerId,
        attempts: 1,
        retryable: isRetryableDecisionFailure(failureKind),
        ...details,
      },
      // Never the provider's message: only the category and, at most, the status
      // code, which is already in `details`.
      `decision provider "${providerId}" failed: ${failureKind}`,
    );
  }

  function normalizeUsage(raw: unknown): AIUsage | undefined {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return undefined;
    }
    const usage = raw as Record<string, unknown>;
    const input = usage["inputTokens"];
    const output = usage["outputTokens"];
    if (typeof input !== "number" || typeof output !== "number") {
      // Partial or absent usage is *unavailable*, never zero.
      return undefined;
    }
    const cached = usage["cachedInputTokens"] ?? 0;
    try {
      return assertValidUsage(
        {
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: cached,
        },
        "usage",
      );
    } catch {
      // A provider reporting cached tokens above input tokens is not a rounding
      // problem: the response does not mean what it claims.
      fail("malformed-response", { statusCode: 200 });
    }
  }

  /** Parses the body once, bounding it first. The body is never echoed. */
  function parseResponse(body: string): JevWireResponse {
    if (body.length > MAX_JEV_RESPONSE_CHARS) {
      fail("malformed-response", { statusCode: 200 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      fail("malformed-response", { statusCode: 200 });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      fail("malformed-response", { statusCode: 200 });
    }
    return parsed as JevWireResponse;
  }

  function normalizeResponse(parsed: JevWireResponse): DecisionResponse {
    const outcome = parsed.outcome;
    if (outcome === "abstained") {
      // The provider's own words for *why* it declined are read and dropped. What is
      // recorded is the fact of abstention and the deterministic answer that replaced
      // it.
      return { outcome: "abstained", reason: "provider abstained" };
    }
    if (outcome === "escalated") {
      const reasonCode = optionalReasonCode(parsed.reasonCode);
      return {
        outcome: "escalated",
        reason: "provider escalated",
        ...(reasonCode === undefined ? {} : { reasonCode }),
      };
    }
    if (outcome === "failed") {
      return { outcome: "failed", error: "provider reported failure" };
    }
    if (outcome !== "selected") {
      fail("malformed-response", { statusCode: 200 });
    }

    let optionId: string;
    try {
      optionId = shortToken(parsed.optionId, "optionId");
    } catch {
      fail("malformed-response", { statusCode: 200 });
    }

    const rankedOptionIds = parsed.rankedOptionIds;
    let ranked: readonly string[] | undefined;
    if (rankedOptionIds !== undefined) {
      if (
        !Array.isArray(rankedOptionIds) ||
        rankedOptionIds.length > MAX_JEV_RANKED_IDS
      ) {
        fail("malformed-response", { statusCode: 200 });
      }
      try {
        ranked = rankedOptionIds.map((id) =>
          shortToken(id, "rankedOptionIds[]"),
        );
      } catch {
        fail("malformed-response", { statusCode: 200 });
      }
    }

    const reasonCode = optionalReasonCode(parsed.reasonCode);

    let confidence: number | undefined;
    if (parsed.confidence !== undefined) {
      const value = parsed.confidence;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
      ) {
        fail("malformed-response", { statusCode: 200 });
      }
      confidence = value;
    }

    return {
      outcome: "selected",
      optionId,
      ...(ranked === undefined ? {} : { rankedOptionIds: ranked }),
      ...(reasonCode === undefined ? {} : { reasonCode }),
      ...(confidence === undefined ? {} : { confidence }),
    };
  }

  function optionalReasonCode(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    // A reason code is a token from a closed vocabulary. Anything else — prose, a
    // sentence, a paragraph — is a malformed response rather than something to be
    // truncated into the log.
    if (typeof value !== "string" || !isReasonCode(value)) {
      fail("malformed-response", { statusCode: 200 });
    }
    return value;
  }

  return {
    id: providerId,
    family: JEV_FAMILY,

    capabilities: () => ({
      // JEV answers ordinary bounded questions about whether something is a
      // reasonable choice. It does not answer questions that belong to deterministic
      // code: the policy, approval and escalation-decision kinds stay out, and a
      // request for one is refused before it is sent.
      kinds: [
        "routing",
        "tool-selection",
        "risk-assessment",
        "retry",
        "completion",
        "ranking",
        "relevance",
        "human-escalation",
        "execution-strategy",
        "context-selection",
        "skill-selection",
      ],
      deterministic: false,
      maxOptions: 8,
    }),

    decide: async (request) => (await decideDetailed(request)).response,

    async decideWithMetadata(
      request: DecisionRequest,
    ): Promise<DecisionProviderResult> {
      return decideDetailed(request);
    },
  };

  async function decideDetailed(
    request: DecisionRequest,
  ): Promise<DecisionProviderResult> {
    const body: Record<string, unknown> = {
      kind: request.kind,
      question: request.question,
      options: request.options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
      context: [...request.context],
      ...(request.reasonCodes === undefined
        ? {}
        : { reasonCodes: [...request.reasonCodes] }),
      ...(request.ranked === true ? { ranked: true } : {}),
      ...(request.maxLatencyMs === undefined &&
      request.maxCostMicros === undefined
        ? {}
        : {
            constraints: {
              ...(request.maxLatencyMs === undefined
                ? {}
                : { maxLatencyMs: request.maxLatencyMs }),
              ...(request.maxCostMicros === undefined
                ? {}
                : { maxCostMicros: request.maxCostMicros }),
            },
          }),
      correlationId: request.correlationId,
    };
    const serialized = JSON.stringify(body);
    if (serialized.length > MAX_JEV_REQUEST_CHARS) {
      // Defence in depth: the engine already bounds the input. A request that
      // outgrew the bound is refused locally rather than sent and hoped for.
      fail("refused");
    }

    const credential = options.environment.get(credentialEnvVar);
    if (credential === undefined || credential.length === 0) {
      throw new DecisionProviderError(
        {
          failureKind: "auth",
          providerId,
          attempts: 1,
          retryable: false,
        },
        `decision provider "${providerId}" has no credential: environment ` +
          `variable ${credentialEnvVar} is not set`,
      );
    }

    const startedAt = toIsoString(options.clock.now());
    let response;
    try {
      response = await options.transport.send({
        url: `${baseUrl}/decide`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${credential}`,
        },
        body: serialized,
        timeoutMs: request.maxLatencyMs ?? timeoutMs,
        correlationId: request.correlationId,
      });
    } catch (error) {
      if (isHttpTransportError(error)) {
        fail(error.failureKind);
      }
      if (error instanceof DecisionProviderError) {
        throw error;
      }
      fail("unknown");
    }

    const latencyMs = durationMsFrom(
      startedAt,
      toIsoString(options.clock.now()),
    );

    if (response.status < 200 || response.status >= 300) {
      fail(classifyDecisionStatus(response.status), {
        statusCode: response.status,
      });
    }

    const metadata = parseResponse(response.body);
    const normalized = normalizeResponse(metadata);
    const usage = normalizeUsage(metadata.usage);
    const modelId =
      typeof metadata.model === "string" && metadata.model.length > 0
        ? metadata.model
        : options.modelId;
    const requestId =
      typeof metadata.requestId === "string" && metadata.requestId.length > 0
        ? metadata.requestId
        : undefined;

    return {
      response: normalized,
      latencyMs,
      ...(usage === undefined ? {} : { usage }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
}

/**
 * The failure kinds this adapter can produce, re-exported for tests that assert the
 * taxonomy is shared with the LLM port rather than reinvented.
 */
export const JEV_FAILURE_KINDS: readonly DecisionFailureKind[] =
  DECISION_FAILURE_KINDS;
