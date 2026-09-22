import { describe, expect, it } from "vitest";

import { createFetchTransport } from "../../src/adapters/http/fetch-transport.js";
import {
  type HttpRequest,
  type HttpStreamResponse,
  HttpTransportError,
  type HttpTransport,
  isHttpTransportError,
} from "../../src/ports/http-transport.js";

/**
 * The one module in the platform that opens a socket, tested against an injected
 * `fetch` and therefore offline.
 *
 * Two properties matter more than the happy path, and both are asserted directly:
 * a failure never carries a header or a body fragment (the classic route by which an
 * API key reaches a log), and a stream that dies part-way is translated into the same
 * two categories as one that never connected — otherwise a dropped connection would
 * arrive as an unclassified error and be reported as `unknown`, which is the one
 * category the retry policy refuses to retry.
 */
const SECRET = "sk-fixture-abcdefghijklmnop";

const REQUEST: HttpRequest = {
  url: "https://fixture.invalid/v1/chat/completions",
  method: "POST",
  headers: { authorization: `Bearer ${SECRET}` },
  body: JSON.stringify({ model: "fixture" }),
  timeoutMs: 1_000,
  correlationId: "corr-transport-1",
};

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** A body stream that replays scripted pieces and can fail on demand. */
function bodyOf(
  pieces: readonly (string | Uint8Array | Error)[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[index];
      index += 1;
      if (piece === undefined) {
        controller.close();
        return;
      }
      if (piece instanceof Error) {
        controller.error(piece);
        return;
      }
      controller.enqueue(typeof piece === "string" ? encoder.encode(piece) : piece);
    },
  });
}

interface FakeResponseInit {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** `null` models a 2xx that carried no body at all. */
  readonly bodyStream?: ReadableStream<Uint8Array> | null;
  readonly onRead?: () => void;
}

function fakeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(init.headers ?? {}),
    body: init.bodyStream === undefined ? null : init.bodyStream,
    async text(): Promise<string> {
      init.onRead?.();
      return init.body ?? "";
    },
  } as unknown as Response;
}

function transportWith(
  outcome: Response | Error,
  captured: { init?: RequestInit } = {},
): ReturnType<typeof createFetchTransport> {
  return createFetchTransport({
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      captured.init = init;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    }) as unknown as typeof fetch,
  });
}

async function failureOf(call: () => Promise<unknown>): Promise<HttpTransportError> {
  const outcome = await call().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isHttpTransportError(outcome)) {
    throw new Error(
      `expected an HttpTransportError, got: ${String(outcome ?? "a successful call")}`,
    );
  }
  return outcome;
}

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) {
    text += chunk;
  }
  return text;
}

/**
 * The transport's streaming entry point, asserted present.
 *
 * `sendStream` is optional on the port because not every transport can stream, and a
 * test that reaches for it should fail loudly if that ever stops being true rather
 * than silently skipping its assertions.
 */
function streaming(
  transport: HttpTransport,
): (request: HttpRequest) => Promise<HttpStreamResponse> {
  const send = transport.sendStream;
  if (send === undefined) {
    throw new Error("the fetch transport must expose sendStream");
  }
  return send.bind(transport);
}

describe("fetch transport: buffered", () => {
  it("returns status, lower-cased headers and the body as sent", async () => {
    const captured: { init?: RequestInit } = {};
    const transport = transportWith(
      fakeResponse({
        status: 201,
        headers: { "Content-Type": "application/json", "X-Request-Id": "r-1" },
        body: '{"ok":true}',
      }),
      captured,
    );

    const response = await transport.send(REQUEST);
    expect(response.status).toBe(201);
    // Header keys are normalised so a lookup never depends on the peer's casing.
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["x-request-id"]).toBe("r-1");
    expect(response.body).toBe('{"ok":true}');
    expect(captured.init?.method).toBe("POST");
    expect(captured.init?.body).toBe(REQUEST.body);
    expect(captured.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits the body entirely for a method that carries none", async () => {
    const captured: { init?: RequestInit } = {};
    const transport = transportWith(fakeResponse({ body: "{}" }), captured);
    await transport.send({ ...REQUEST, method: "GET", body: undefined });
    // `fetch` rejects a body on a bodyless method, so it must not be passed at all.
    expect("body" in (captured.init ?? {})).toBe(false);
  });

  it("classifies a timeout by name and reports the origin, not the request", async () => {
    const transport = transportWith(namedError("TimeoutError", "aborted"));
    const failure = await failureOf(() => transport.send(REQUEST));

    expect(failure.failureKind).toBe("timeout");
    expect(failure.details["origin"]).toBe("https://fixture.invalid");
    const serialised = `${failure.message} ${JSON.stringify(failure.details)}`;
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain("authorization");
    expect(serialised).not.toContain("fixture\""); // no body fragment either
  });

  it("classifies a socket failure as a network failure", async () => {
    const transport = transportWith(namedError("TypeError", "fetch failed"));
    const failure = await failureOf(() => transport.send(REQUEST));
    expect(failure.failureKind).toBe("network");
    expect(failure.details["errorName"]).toBe("TypeError");
  });
});

describe("fetch transport: streaming", () => {
  it("exposes the status as soon as the peer answers, then yields decoded text", async () => {
    const transport = transportWith(
      fakeResponse({ status: 200, bodyStream: bodyOf(["a", "b", "c"]) }),
    );

    const stream = await streaming(transport)(REQUEST);
    // The status is available before the body has been read at all, which is the whole
    // reason the buffered and streamed paths are separate.
    expect(stream.status).toBe(200);
    expect(await collect(stream.chunks)).toBe("abc");
  });

  it("never splits a multi-byte character across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("héllo — ünïcode");
    const transport = transportWith(
      fakeResponse({
        bodyStream: bodyOf([
          bytes.slice(0, 2),
          bytes.slice(2, 3),
          bytes.slice(3, 9),
          bytes.slice(9),
        ]),
      }),
    );

    const stream = await streaming(transport)(REQUEST);
    expect(await collect(stream.chunks)).toBe("héllo — ünïcode");
  });

  it("drains and discards a refusal body, yielding no chunks", async () => {
    let drained = false;
    const transport = transportWith(
      fakeResponse({
        status: 429,
        headers: { "Retry-After": "3" },
        body: "vendor prose that must not travel",
        onRead: () => {
          drained = true;
        },
      }),
    );

    const stream = await streaming(transport)(REQUEST);
    expect(stream.status).toBe(429);
    expect(stream.headers["retry-after"]).toBe("3");
    // Drained so the connection is released, and then dropped: the caller classifies
    // from the status, and vendor text never reaches an error or a log.
    expect(drained).toBe(true);
    expect(await collect(stream.chunks)).toBe("");
  });

  it("translates a stream that dies part-way into a network failure", async () => {
    const transport = transportWith(
      fakeResponse({
        bodyStream: bodyOf([
          "data: one\n\n",
          namedError("TypeError", "terminated"),
        ]),
      }),
    );

    const stream = await streaming(transport)(REQUEST);
    const failure = await failureOf(() => collect(stream.chunks));
    expect(failure.failureKind).toBe("network");
    expect(failure.details["origin"]).toBe("https://fixture.invalid");
  });

  it("translates an aborted stream into a timeout", async () => {
    const transport = transportWith(
      fakeResponse({
        bodyStream: bodyOf([namedError("AbortError", "aborted")]),
      }),
    );

    const stream = await streaming(transport)(REQUEST);
    const failure = await failureOf(() => collect(stream.chunks));
    expect(failure.failureKind).toBe("timeout");
    expect(failure.details["timeoutMs"]).toBe(REQUEST.timeoutMs);
  });

  it("treats a 2xx with no body as a network failure", async () => {
    const transport = transportWith(fakeResponse({ status: 200, bodyStream: null }));
    const failure = await failureOf(() => streaming(transport)(REQUEST));
    expect(failure.failureKind).toBe("network");
  });

  it("keeps the credential out of a streaming failure", async () => {
    const transport = transportWith(
      fakeResponse({ bodyStream: bodyOf([namedError("TypeError", "terminated")]) }),
    );

    const stream = await streaming(transport)(REQUEST);
    const failure = await failureOf(() => collect(stream.chunks));
    const serialised = `${failure.message} ${JSON.stringify(failure.details)}`;
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain("Bearer");
  });

  it("refuses to construct without a fetch implementation", () => {
    const original = globalThis.fetch;
    try {
      // A runtime with no `fetch` must fail at construction, where the problem is
      // visible, rather than at the first call where it would look like a provider fault.
      (globalThis as { fetch?: typeof fetch }).fetch = undefined;
      expect(() => createFetchTransport()).toThrow(/no fetch implementation/);
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = original;
    }
  });
});
