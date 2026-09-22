import { DomainError } from "../../core/errors.js";
import {
  type HttpRequest,
  type HttpResponse,
  type HttpStreamResponse,
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

/** Header values are lower-cased by key so lookups do not depend on the peer. */
function collectHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/**
 * Translates one thrown value into the transport's two failure categories.
 *
 * Shared by the initial connection and by a read that fails part-way through: the
 * same abort signal governs both, so the same translation must apply to both, or a
 * dropped stream would surface as an unclassified error and be reported as
 * `unknown` instead of a retryable `network` failure.
 */
function translateFailure(
  error: unknown,
  request: HttpRequest,
  origin: string,
): never {
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

/**
 * Decodes a body stream, translating a mid-flight failure.
 *
 * Multi-byte characters split across chunk boundaries are the reason for the
 * streaming `TextDecoder`: decoding each chunk independently would corrupt any
 * character that straddles two of them.
 */
async function* decodeChunks(
  body: ReadableStream<Uint8Array | string>,
  request: HttpRequest,
  origin: string,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value === undefined) {
        continue;
      }
      const text =
        typeof value === "string"
          ? value
          : decoder.decode(value, { stream: true });
      if (text.length > 0) {
        yield text;
      }
    }
  } catch (error) {
    translateFailure(error, request, origin);
  } finally {
    // Releasing the reader releases the connection. Already-closed and aborted
    // streams are the normal case here, not an error worth surfacing.
    try {
      await reader.cancel();
    } catch {
      /* the stream is gone either way */
    }
  }
}

/**
 * An iterable that yields nothing: a response whose body is not this caller's to read.
 *
 * Written as an explicit iterator rather than an empty generator, so the "there is
 * nothing here" case is a value the reader can see rather than a function that has to
 * be run to discover it.
 */
function emptyChunks(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
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
          // A bodyless method must not be handed a body, not even an empty one.
          ...(request.body === undefined ? {} : { body: request.body }),
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
      return { status: response.status, headers: collectHeaders(response), body };
    },

    async sendStream(request: HttpRequest): Promise<HttpStreamResponse> {
      const origin = safeOrigin(request.url);
      let response: Response;
      try {
        response = await doFetch(request.url, {
          method: request.method,
          headers: { ...request.headers },
          ...(request.body === undefined ? {} : { body: request.body }),
          // The same overall deadline governs the buffered and the streamed path,
          // and it covers the whole stream: the signal aborts an in-progress read
          // too, so a generator that stalls half-way cannot outlive its budget.
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (error) {
        translateFailure(error, request, origin);
      }

      if (!response.ok) {
        // The body is drained so the connection is released, and then discarded:
        // an error body is vendor text that must never travel further, and the
        // caller classifies the failure from the status alone.
        try {
          await response.text();
        } catch {
          /* nothing to drain, or already closed */
        }
        return {
          status: response.status,
          headers: collectHeaders(response),
          chunks: emptyChunks(),
        };
      }

      const body = response.body;
      if (body === null) {
        // A 2xx with no body is a transport-level problem, not a provider one.
        throw new HttpTransportError(
          "network",
          `no response body from ${origin}`,
          { origin, correlationId: request.correlationId },
        );
      }
      return {
        status: response.status,
        headers: collectHeaders(response),
        chunks: decodeChunks(body, request, origin),
      };
    },
  };
}
