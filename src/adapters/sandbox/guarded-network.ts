import { DomainError } from "../../core/errors.js";
import { hostAllowedBy } from "../../policy/access-policy.js";
import type { PolicyReasonCode } from "../../policy/reason.js";
import { safeUrl, urlTarget } from "../../policy/target.js";
import type { OperationRefusal } from "../../ports/operation.js";
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../../ports/http-transport.js";

/**
 * The network boundary: one allowlist, checked at the last possible moment.
 *
 * Two reach sets exist and they are deliberately not the same set:
 *
 * - `operationHosts` — what an *operation* may reach (`network.connect`);
 * - `providerHosts` — what the platform's own LLM egress may reach.
 *
 * Keeping them apart is the point: configuring a vendor must not silently grant an
 * agent that vendor's host, and no operation can widen the provider set. Both are
 * enforced here rather than at the call site, so an adapter that forgets to ask
 * cannot get through — the transport itself refuses (ADR-050).
 *
 * The provider-facing failure is a `DomainError("FORBIDDEN")`, which the retry
 * decorator already treats as fatal and which never carries a header value, a query
 * string or a body.
 */
export class NetworkBoundaryError extends DomainError {
  readonly reasonCode: PolicyReasonCode;
  readonly safeTarget: string;

  constructor(reasonCode: PolicyReasonCode, safeTarget: string) {
    super(
      "FORBIDDEN",
      `network boundary refused ${safeTarget} (${reasonCode})`,
      { reasonCode, target: safeTarget },
    );
    this.name = "NetworkBoundaryError";
    this.reasonCode = reasonCode;
    this.safeTarget = safeTarget;
  }
}

export function isNetworkBoundaryError(
  value: unknown,
): value is NetworkBoundaryError {
  return value instanceof NetworkBoundaryError;
}

export interface GuardedNetworkOptions {
  readonly transport: HttpTransport;
  /** Hosts an operation may reach. Empty means no operation egress. */
  readonly operationHosts: readonly string[];
  /** Hosts platform provider egress may reach. Never widened by an operation. */
  readonly providerHosts: readonly string[];
  readonly operationEnabled: boolean;
  readonly defaultTimeoutMs?: number;
}

export interface GuardedNetwork {
  readonly id: string;
  /** The transport a provider adapter is given. */
  readonly providerTransport: HttpTransport;
  admitUrl(url: string): OperationRefusal | undefined;
  request(request: {
    readonly url: string;
    readonly method: "GET" | "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs?: number;
    readonly correlationId?: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly result: { readonly status: number; readonly body: string };
      }
    | { readonly ok: false; readonly refusal: OperationRefusal }
  >;
}

const refusal = (
  reasonCode: PolicyReasonCode,
  reason: string,
): OperationRefusal => ({ reasonCode, reason });

/** Host of a URL, or `undefined` when it is not a usable absolute http(s) URL. */
export function urlHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function createGuardedNetwork(
  options: GuardedNetworkOptions,
): GuardedNetwork {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;

  function admitUrl(url: string): OperationRefusal | undefined {
    try {
      urlTarget(url, "url");
    } catch (error) {
      return refusal(
        "TARGET_REFUSED",
        error instanceof DomainError
          ? error.message
          : "the request URL was refused",
      );
    }
    if (!options.operationEnabled) {
      return refusal("POLICY_DENIED", "network access is disabled by policy");
    }
    const host = urlHost(url);
    if (host === undefined) {
      return refusal("UNRESOLVED_TARGET", "the request URL has no host");
    }
    if (hostAllowedBy(options.operationHosts, host) === undefined) {
      return refusal(
        "TARGET_NOT_ALLOWED",
        `host "${host}" is not on policy.network.allowedHosts`,
      );
    }
    return undefined;
  }

  const providerTransport: HttpTransport = {
    id: `${options.transport.id}:guarded-provider`,
    async send(request: HttpRequest): Promise<HttpResponse> {
      const host = urlHost(request.url);
      const safe = safeUrl(request.url);
      if (
        host === undefined ||
        hostAllowedBy(options.providerHosts, host) === undefined
      ) {
        throw new NetworkBoundaryError("TARGET_NOT_ALLOWED", safe);
      }
      return await options.transport.send(request);
    },
  };

  return {
    id: "guarded-network",
    providerTransport,
    admitUrl,

    async request(request) {
      const admitted = admitUrl(request.url);
      if (admitted !== undefined) {
        return { ok: false, refusal: admitted };
      }
      const response = await options.transport.send({
        url: request.url,
        method: request.method,
        headers: request.headers ?? {},
        // A GET must not carry a body, not even an empty one; fetch rejects it.
        ...(request.method === "POST" ? { body: request.body ?? "" } : {}),
        timeoutMs: request.timeoutMs ?? defaultTimeoutMs,
        correlationId: request.correlationId ?? "operation",
      });
      return {
        ok: true,
        result: { status: response.status, body: response.body },
      };
    },
  };
}
