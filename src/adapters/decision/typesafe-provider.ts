import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type Fetch,
  choice,
  score,
} from "@typesafe-ai/sdk";

import type { Clock } from "../../core/clock.js";
import { durationMsFrom, toIsoString } from "../../core/clock.js";
import { DomainError, hasDomainErrorCode } from "../../core/errors.js";
import { assertNonEmptyString } from "../../core/validation.js";
import {
  MAX_DECISION_INPUT_CHARS,
  isReasonCode,
} from "../../decisions/domains.js";
import {
  DECISION_FAILURE_KINDS,
  type DecisionFailureKind,
  type DecisionProviderResult,
  type DecisionRequest,
  type DecisionResponse,
  type UsageReportingDecisionProvider,
  attestLiveSdkExecution,
  DecisionProviderError,
} from "../../decisions/provider.js";
import { assertValidUsage, type AIUsage } from "../../observability/usage.js";
import type { Environment } from "../../ports/environment.js";
import {
  type HttpTransport,
  isHttpTransportError,
} from "../../ports/http-transport.js";

/**
 * TypeSafe is the JEV implementation: the decision layer behind the
 * `DecisionProvider` port.
 *
 * This adapter is the *only* module in the repository that imports the TypeSafe SDK,
 * and it imports the vendored shape of it exactly once. Everything above sees
 * `DecisionRequest` and `DecisionResponse`; nothing JEV-specific escapes this file
 * (ADR-022, ADR-051, ADR-057).
 *
 * Four rules are enforced here rather than documented as intentions:
 *
 * - **One network path.** The SDK is given a `fetch` that is not `globalThis.fetch`
 *   but a bridge onto the injected `HttpTransport` — which in a real runtime is the
 *   Phase F network boundary guard. A provider host that policy does not allow is
 *   refused *before* a socket exists, and the refusal is reported as a refusal
 *   rather than retried as if it were a connection error (ADR-050).
 * - **Credentials are referenced, never stored.** The environment variable is read
 *   through the `Environment` port at call time and handed to a client that exists
 *   only for that call. Nothing is cached, logged or recorded; a missing credential
 *   fails before any network activity, and the message names the variable.
 * - **Nothing TypeSafe says is trusted.** A label is mapped back to a candidate id
 *   by exact membership, a confidence outside `[0, 1]` is a malformed response, and a
 *   reason code outside the offered vocabulary is dropped. The deterministic
 *   validator then checks the result again before it can influence anything.
 * - **No retries here.** The SDK's own retry policy is disabled: retry belongs to the
 *   layer that owns a retry budget (ADR-052), and a hidden retry would spend tokens
 *   the budget never saw.
 *
 * Usage is optional and honest: TypeSafe reports input/output tokens, so `usage` is
 * set from what it reported, and a response without usage yields *no* usage rather
 * than zeroes (ADR-035).
 */

export const TYPESAFE_PROVIDER_ID = "typesafe";
export const TYPESAFE_FAMILY = "jev" as const;
export const DEFAULT_TYPESAFE_CREDENTIAL_ENV_VAR = "TYPESAFE_API_KEY";
export const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_TYPESAFE_MODEL = "jev-latest";
export const DEFAULT_TYPESAFE_TIMEOUT_MS = 15_000;

/**
 * A refusal raised by policy (egress, capability, approval) rather than by the
 * network. Checked by domain code so this adapter stays independent of the adapter
 * that raised it: any `FORBIDDEN` domain error during a provider call means the same
 * thing to the decision layer — the call was refused, so it is not retryable.
 */
function isRefusal(value: unknown): boolean {
  return hasDomainErrorCode(value, "FORBIDDEN");
}

/**
 * The rubric a ranked question uses.
 *
 * An ordered rubric rather than a free numeric score: TypeSafe returns an expected
 * score over the rubric, which gives a total order without inviting the model to
 * invent a scale.
 */
export const RANKING_RUBRIC = [
  "cannot perform this at all",
  "performs this poorly",
  "performs this adequately",
  "performs this well",
  "performs this excellently",
] as const;

export interface TypeSafeProviderOptions {
  /** Name of the environment variable holding the credential. Never the key. */
  readonly credentialEnvVar?: string;
  /** API root. Defaults to the documented `https://api.typesafe.ai`. */
  readonly baseUrl?: string;
  /** Default JEV model. Defaults to the documented `jev-latest`. */
  readonly defaultModel?: string;
  readonly environment: Environment;
  /** The guarded transport. This adapter never opens a socket itself. */
  readonly transport: HttpTransport;
  readonly clock: Clock;
  readonly timeoutMs?: number;
  readonly id?: string;
}

/**
 * A response that cannot be used.
 *
 * Categorised rather than narrated: the engine records that the answer was unusable
 * and answers deterministically, and the payload the provider sent never reaches the
 * event log.
 */
function malformed(field: string): never {
  throw new DecisionProviderError(
    {
      failureKind: "malformed-response",
      providerId: TYPESAFE_PROVIDER_ID,
      attempts: 1,
      retryable: false,
      statusCode: 200,
    },
    `decision provider "${TYPESAFE_PROVIDER_ID}" returned an unusable ${field}`,
  );
}

/** A reason code the provider answered with, if it is one of the offered codes. */
function offeredReasonCode(
  value: unknown,
  offered: readonly string[],
): string | undefined {
  if (typeof value !== "string" || !isReasonCode(value)) {
    return undefined;
  }
  return offered.includes(value) ? value : undefined;
}

export function createTypeSafeProvider(
  options: TypeSafeProviderOptions,
): UsageReportingDecisionProvider {
  const providerId = options.id ?? TYPESAFE_PROVIDER_ID;
  const credentialEnvVar = assertNonEmptyString(
    options.credentialEnvVar ?? DEFAULT_TYPESAFE_CREDENTIAL_ENV_VAR,
    "credentialEnvVar",
  );
  const baseUrl = (options.baseUrl ?? DEFAULT_TYPESAFE_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const defaultModel = options.defaultModel ?? DEFAULT_TYPESAFE_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TYPESAFE_TIMEOUT_MS;

  function fail(
    failureKind: DecisionFailureKind,
    details: { statusCode?: number } = {},
  ): never {
    throw new DecisionProviderError(
      {
        failureKind,
        providerId,
        attempts: 1,
        retryable:
          failureKind === "rate-limit" ||
          failureKind === "timeout" ||
          failureKind === "network" ||
          failureKind === "server",
        ...details,
      },
      // Category and status only. Never the SDK's message, which can carry a URL,
      // never the request body, and never an authorization header.
      `decision provider "${providerId}" failed: ${failureKind}`,
    );
  }

  function classify(error: unknown): DecisionFailureKind {
    if (isRefusal(error)) {
      // Policy refused the host (or the operation). A refusal is not a connection
      // error, and it is never retryable: repeating it asks the same boundary the
      // same question. Checked by domain code so this adapter never imports the
      // sandbox adapter that raised it.
      return "refused";
    }
    if (isHttpTransportError(error)) {
      return error.failureKind;
    }
    if (error instanceof APITimeoutError) {
      return "timeout";
    }
    if (error instanceof APIConnectionError) {
      return "network";
    }
    if (error instanceof RateLimitError) {
      return "rate-limit";
    }
    if (error instanceof PermissionDeniedError) {
      return "auth";
    }
    if (
      error instanceof BadRequestError ||
      error instanceof UnprocessableEntityError
    ) {
      // Our request was unacceptable. Retrying it would be retrying our own bug.
      return "refused";
    }
    if (error instanceof InternalServerError) {
      return "server";
    }
    if (error instanceof APIUserAbortError) {
      // No caller signal is ever passed, so an abort can only be the per-attempt
      // timeout firing.
      return "timeout";
    }
    if (error instanceof APIError) {
      return classifyStatus(error.status);
    }
    return "unknown";
  }

  function classifyStatus(status: number): DecisionFailureKind {
    if (status === 401 || status === 403) {
      return "auth";
    }
    if (status === 404) {
      return "unavailable";
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
    return "unknown";
  }

  /**
   * The bridge from the SDK's `fetch` to the injected transport.
   *
   * The SDK is handed this and nothing else, so it cannot reach the network on a path
   * the platform's policy guard has not seen. `correlationId` is bound per call so the
   * transport can attribute the request without the SDK knowing about it.
   */
  function bridgeFor(correlationId: string): Fetch {
    return async (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "POST") {
        throw new DomainError(
          "VALIDATION",
          `the decision transport supports GET and POST, not "${method}"`,
          { field: "method" },
        );
      }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const body = typeof init?.body === "string" ? init.body : undefined;
      const response = await options.transport.send({
        url: input,
        method,
        headers,
        ...(method === "POST" ? { body: body ?? "" } : {}),
        timeoutMs,
        correlationId,
      });
      return new Response(response.body, {
        status: response.status,
        // Provider headers are forwarded so the SDK can read its own request id.
        // They are never logged: the client runs at `logLevel: "off"`.
        headers: {
          "content-type": "application/json",
          ...response.headers,
        },
      });
    };
  }

  /** A client that lives for exactly one call, built without touching `process.env`. */
  function clientFor(apiKey: string, correlationId: string): TypeSafeClient {
    return new TypeSafeClient({
      // Passed explicitly so the SDK never reads the process environment itself:
      // the `Environment` port stays the single reader, which is what keeps a
      // developer's real key out of a test run.
      apiKey,
      baseURL: baseUrl,
      defaultModel,
      // Nothing the SDK logs can reach anywhere: `off` means no request summaries,
      // no headers and no bodies.
      logLevel: "off",
      // One attempt per call. Retry policy lives above this adapter.
      retry: { maxRetries: 0 },
      timeout: timeoutMs,
      fetch: bridgeFor(correlationId),
    });
  }

  return {
    id: providerId,
    family: TYPESAFE_FAMILY,

    capabilities: () => ({
      // The bounded domains this JEV is asked about. The deterministic kinds
      // (policy, approval, security) are not among them and a request for one is
      // refused by the engine before it is sent.
      //
      // `execution-strategy` is the newest and is declared deliberately: nothing is
      // sent to a provider about a question kind the provider has not been told it
      // will be asked. A JEV that does not answer it (abstains) is not a failure —
      // abstention falls back to the domain's own conservative default, which is
      // recorded as a fallback rather than as an answer.
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

    decideWithMetadata: (request) => decideDetailed(request),
  };

  async function decideDetailed(
    request: DecisionRequest,
  ): Promise<DecisionProviderResult> {
    const state = {
      question: request.question,
      options: request.options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
      context: [...request.context],
    };
    const serialized = JSON.stringify(state);
    if (serialized.length > MAX_DECISION_INPUT_CHARS) {
      // Defence in depth: the decision engine already bounds a spec. A request that
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
    let result;
    try {
      result = await clientFor(credential, request.correlationId)
        .systemOne(buildQuestions(request, state))
        .withResponse();
    } catch (error) {
      // The SDK wraps transport failures in `APIConnectionError` with the original
      // error as `cause`. Unwrapping first is what preserves a policy refusal's
      // identity instead of degrading it into "connection error".
      const cause = (error as { cause?: unknown }).cause;
      if (cause !== undefined && !(cause instanceof APIError)) {
        if (isRefusal(cause) || isHttpTransportError(cause)) {
          fail(classify(cause));
        }
      }
      if (isRefusal(error)) {
        // A refusal that arrived unwrapped still belongs to the refusal category
        // rather than to the generic "our own DomainError" bucket.
        fail("refused");
      }
      if (error instanceof DomainError) {
        // Our own validation failure, not a provider failure: propagate it.
        throw error;
      }
      // The HTTP status, when the SDK knows one: the category and the code are the
      // whole record, and neither can carry the provider's words.
      fail(
        classify(error),
        error instanceof APIError ? { statusCode: error.status } : {},
      );
    }

    const latencyMs = durationMsFrom(
      startedAt,
      toIsoString(options.clock.now()),
    );
    const modelId =
      typeof result.data.model === "string" && result.data.model.length > 0
        ? result.data.model
        : defaultModel;

    const usage = normalizeUsage(result.data.usage);
    return {
      response: interpret(request, result.data.answers as AnswersLike),
      latencyMs,
      modelId,
      ...(usage === undefined ? {} : { usage }),
      ...(result.requestId === undefined
        ? {}
        : { requestId: result.requestId }),
      // The one place the live-SDK provenance marker can be minted: here, where the
      // actual `systemOne(...).withResponse()` above has resolved. Everything that
      // fails before this point (credential, transport, classification) returns or
      // throws without it, so an unexecuted call can never attest.
      executionSource: attestLiveSdkExecution(),
    };
  }
}

interface TypeSafeQuestionState {
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly context: readonly string[];
}

/**
 * Maps one bounded question onto a TypeSafe request.
 *
 * The mapping is total and stable: a ranked question becomes one score question per
 * candidate against a fixed rubric, and everything else becomes a single choice
 * question keyed by candidate id. Labels *are* the option ids, which is what makes
 * mapping the answer back an exact lookup rather than a fuzzy one. There is no
 * "pick a model name you like" question anywhere: a model the caller did not offer
 * cannot come back.
 */
function buildQuestions(
  request: DecisionRequest,
  state: TypeSafeQuestionState,
): Parameters<TypeSafeClient["systemOne"]>[0] {
  const description = `${state.question}\n${state.context.join("\n")}`;
  const questions: Record<string, unknown> = {};
  if (request.ranked === true) {
    state.options.forEach((option, index) => {
      questions[`rank_${index}`] = score(
        `How well does candidate "${option.id}" (${option.label}) satisfy: ${description}`,
        RANKING_RUBRIC,
      );
    });
  } else {
    const criteria: Record<string, string> = {};
    for (const option of state.options) {
      criteria[option.id] = option.label;
    }
    questions["decision"] = choice(description, criteria);
    const offered = request.reasonCodes ?? [];
    if (offered.length > 0) {
      const reasonCriteria: Record<string, string> = {};
      for (const code of offered) {
        reasonCriteria[code] = code;
      }
      questions["reason"] = choice(
        "Which explanation code best matches the answer above?",
        reasonCriteria,
      );
    }
  }
  return {
    state: {
      question: state.question,
      options: state.options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
      context: [...state.context],
    },
    questions,
  } as unknown as Parameters<TypeSafeClient["systemOne"]>[0];
}

/** The offered codes, in the order they were offered, for membership checks. */
function offeredCodes(request: DecisionRequest): readonly string[] {
  return request.reasonCodes ?? [];
}

interface AnswersLike {
  readonly [name: string]: unknown;
}

function asAnswer(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Turns TypeSafe's answers into the port's response.
 *
 * Anything that does not fit is a malformed response, never a repaired one: the
 * engine's validator would reject a fabricated option id anyway, and reporting the
 * truth ("the provider answered with something unusable") is what makes the
 * deterministic fallback visible in the trace.
 */
function interpret(
  request: DecisionRequest,
  answers: AnswersLike,
): DecisionResponse {
  const offered = request.options.map((option) => option.id);
  const codes = offeredCodes(request);
  const reasonCode = (() => {
    const answer = asAnswer(answers["reason"]);
    if (answer === undefined) {
      return undefined;
    }
    return offeredReasonCode(answer["choice"], codes);
  })();

  if (request.ranked === true) {
    const scored: { id: string; score: number; index: number }[] = [];
    for (const [index, optionId] of offered.entries()) {
      const answer = asAnswer(answers[`rank_${index}`]);
      const value = answer?.["score"];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        malformed(`rank_${index}`);
      }
      scored.push({ id: optionId, score: value, index });
    }
    // Stable ordering: equal scores keep the caller's own order, so a ranking can
    // never be invented out of a tie.
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return {
      outcome: "selected",
      optionId: scored[0]?.id ?? offered[0],
      rankedOptionIds: scored.map((entry) => entry.id),
      ...(reasonCode === undefined ? {} : { reasonCode }),
    };
  }

  const answer = asAnswer(answers["decision"]);
  const selected = answer?.["choice"];
  if (typeof selected !== "string" || !offered.includes(selected)) {
    malformed("choice");
  }
  const confidence = answer?.["confidence"];
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  ) {
    malformed("confidence");
  }
  return {
    outcome: "selected",
    optionId: selected,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

/**
 * TypeSafe reports input and output tokens and does not report cache reads, so the
 * cached count is zero — which is what "no cached tokens were reported" means, and is
 * never a claim about pricing. Absent or unusable usage yields `undefined`.
 */
function normalizeUsage(raw: unknown): AIUsage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const usage = raw as Record<string, unknown>;
  const input = usage["input_tokens"];
  const output = usage["output_tokens"];
  if (typeof input !== "number" || typeof output !== "number") {
    return undefined;
  }
  try {
    return assertValidUsage(
      { inputTokens: input, outputTokens: output, cachedInputTokens: 0 },
      "usage",
    );
  } catch {
    // Usage that does not mean what it claims (cached greater than input) is
    // reported as unavailable rather than repaired into a number nobody can trust.
    return undefined;
  }
}

/** Re-exported so tests can assert the taxonomy is the shared one. */
export const TYPESAFE_FAILURE_KINDS: readonly DecisionFailureKind[] =
  DECISION_FAILURE_KINDS;
