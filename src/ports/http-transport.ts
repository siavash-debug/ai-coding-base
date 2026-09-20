import { DomainError } from "../core/errors.js";

/**
 * HttpTransport port: the network, reduced to one function.
 *
 * The transport exists so that provider adapters can contain *only* request
 * building and response normalisation. That is what makes a real vendor adapter
 * testable against deterministic fixtures with no network, no API key and no test
 * harness trickery — and it keeps the number of modules that can open a socket at
 * exactly one.
 *
 * Implementations MUST NOT throw provider-specific errors: they translate
 * transport-level problems (timeouts, socket failures) into `HttpTransportError`,
 * and they MUST NOT include request headers or bodies in any message they produce.
 * See ADR-035.
 */

/**
 * A transport-level failure: the provider was never reached, or never answered.
 *
 * The kind is a closed set so a provider adapter can categorise it without
 * parsing prose, and so a retry decision stays unambiguous: these are the
 * retryable categories, `auth` and `malformed-response` are not.
 */
export type TransportFailureKind = "timeout" | "network";

export class HttpTransportError extends DomainError {
  readonly failureKind: TransportFailureKind;

  constructor(
    failureKind: TransportFailureKind,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super("TRANSPORT_FAILURE", message, { ...details, failureKind });
    this.name = "HttpTransportError";
    this.failureKind = failureKind;
  }
}

export function isHttpTransportError(
  value: unknown,
): value is HttpTransportError {
  return value instanceof HttpTransportError;
}
export interface HttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  /** Already-serialized body. The transport never inspects it. */
  readonly body: string;
  readonly timeoutMs: number;
  readonly correlationId: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpTransport {
  readonly id: string;
  send(request: HttpRequest): Promise<HttpResponse>;
}
