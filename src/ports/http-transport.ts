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
  /**
   * `POST` for provider chat completions; `GET` is what a read-only operation
   * needs. Both are sent as-is, and a body is only attached to a `POST`.
   */
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Already-serialized body. The transport never inspects it.
   *
   * Absent for a `GET`: a request that carries no entity must not send one, and
   * `fetch` rejects a body on a bodyless method outright.
   */
  readonly body?: string;
  readonly timeoutMs: number;
  readonly correlationId: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * A response whose body is still arriving.
 *
 * The status and headers are known as soon as the peer has answered, which is the
 * whole point of the split: a caller can tell "the provider refused this request"
 * from "the provider is still producing an answer" without waiting for the last
 * byte. A buffered call cannot make that distinction, so a slow generator and a
 * dead one look identical until the deadline expires.
 *
 * `chunks` yields decoded text in arrival order. It is single-use and may only be
 * iterated once. Failure semantics are the transport's: a read that dies part-way
 * throws `HttpTransportError`, exactly as an initial connection failure does, so a
 * caller never has to special-case a mid-stream error.
 */
export interface HttpStreamResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly chunks: AsyncIterable<string>;
}

export interface HttpTransport {
  readonly id: string;
  send(request: HttpRequest): Promise<HttpResponse>;
  /**
   * Incremental variant of `send`, present only on transports that can deliver a
   * body as it arrives.
   *
   * Deliberately optional rather than required: every existing fixture, wrapper and
   * test double stays valid, and a decorator that cannot stream simply does not
   * forward the capability. Callers must test for it with `supportsStreaming`
   * instead of assuming, so "this transport streams" is answered by the transport
   * itself rather than by the caller's hope.
   *
   * Implementations MUST apply the same admission checks, timeouts and redaction
   * rules as `send`. A transport that admits a host for `send` and forgets to admit
   * it for `sendStream` would turn streaming into an egress bypass.
   */
  sendStream?(request: HttpRequest): Promise<HttpStreamResponse>;
}

/** An `HttpTransport` that can deliver a body incrementally. */
export type StreamingHttpTransport = HttpTransport & {
  sendStream(request: HttpRequest): Promise<HttpStreamResponse>;
};

/**
 * Narrows a transport to one that streams, without guessing from configuration.
 *
 * A capability question is answered by the object that has the capability, not by a
 * flag someone else set: a transport assembled from a decorator chain streams only
 * if every layer in that chain forwarded the method.
 */
export function supportsStreaming(
  transport: HttpTransport,
): transport is StreamingHttpTransport {
  return typeof transport.sendStream === "function";
}
