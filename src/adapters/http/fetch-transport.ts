import { DomainError } from "../../core/errors.js";
import {
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  HttpTransportError,
} from "../../ports/http-transport.js";

/**
 * `fetch`-based HTTP transport — the only module in the platform that opens a
 * socket.
 *
 * Everything above it (`LlmProvider` adapters) is pure request building and
 * response normalisation, which is what allows the real provider adapter to be
 * tested against deterministic fixtures with no network and no credentials.
 *
 * Two rules are enforced here rather than trusted to callers:
 *
 * - **No headers in failures.** A transport failure reports the origin, the
 *   timeout and the error *name*. It never echoes `Authorization`, the request
 *   body, or the vendor's response text — the last of these is the classic way an
 *   API key ends up in a log file.
 * - **Timeouts are the transport's job.** One `AbortSignal.timeout` per attempt,
 *   so a hung connection cannot hold a task open indefinitely.
 *
 * This adapter is deliberately thin. Retry, categorisation and accounting all live
 * above it (see `adapters/llm/retrying-provider.ts` and ADR-035).
 */
export interface FetchTransportOptions {
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly id?: string;
}

/** Origin only: a base URL may carry a query string that is not ours to print. */
function safeOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return "<unparseable url>";
  }
}

export function createFetchTransport(
  options: FetchTransportOptions = {},
): HttpTransport {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new DomainError(
      "INVARIANT",
      "no fetch implementation is available in this runtime; pass fetchImpl explicitly",
      { field: "fetchImpl" },
    );
  }

  return {
    id: options.id ?? "fetch",

    async send(request: HttpRequest): Promise<HttpResponse> {
      const origin = safeOrigin(request.url);
      let response: Response;
      try {
        response = await doFetch(request.url, {
          method: request.method,
          headers: { ...request.headers },
          body: request.body,
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new HttpTransportError(
            "timeout",
            `no response from ${origin} within ${request.timeoutMs}ms`,
            {
              origin,
              timeoutMs: request.timeoutMs,
              correlationId: request.correlationId,
            },
          );
        }
        throw new HttpTransportError(
          "network",
          `request to ${origin} failed (${name})`,
          {
            origin,
            errorName: name,
            correlationId: request.correlationId,
          },
        );
      }

      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body };
    },
  };
}
