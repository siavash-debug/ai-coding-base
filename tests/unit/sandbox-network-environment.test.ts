import { describe, expect, it } from "vitest";

import {
  createFakeStreamingTransport,
  createFakeTransport,
  jsonResponse,
} from "../support/llm.js";
import {
  accessPolicy,
  createSandboxFixture,
  FIXTURE_SECRET_VALUE,
  type SandboxFixture,
} from "../support/policy.js";

async function withFixture<T>(
  options: Parameters<typeof createSandboxFixture>[0],
  body: (subject: SandboxFixture) => Promise<T>,
): Promise<T> {
  const subject = await createSandboxFixture(options);
  try {
    return await body(subject);
  } finally {
    await subject.cleanup();
  }
}

describe("sandbox: network boundary", () => {
  it("denies everything by default, without touching the transport", async () => {
    const transport = createFakeTransport([jsonResponse("{}")]);
    await withFixture({ transport }, async (subject) => {
      const refusal = await subject.sandbox.admit({
        kind: "network.request",
        url: "https://api.example.com/v1/things",
        method: "GET",
      });
      expect(refusal?.reasonCode).toBe("POLICY_DENIED");
      const performed = await subject.sandbox.perform({
        kind: "network.request",
        url: "https://api.example.com/v1/things",
        method: "GET",
      });
      expect(performed.ok).toBe(false);
      // A refusal must not have reached the network.
      expect(transport.requests).toHaveLength(0);
    });
  });

  it("reaches a listed host and returns status and body", async () => {
    const transport = createFakeTransport([jsonResponse('{"ok":true}', 200)]);
    await withFixture(
      {
        transport,
        policy: accessPolicy({
          allowed: ["network.connect"],
          networkEnabled: true,
          allowedHosts: ["api.example.com"],
        }),
      },
      async (subject) => {
        const outcome = await subject.sandbox.perform({
          kind: "network.request",
          url: "https://api.example.com/v1/things",
          method: "GET",
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) {
          return;
        }
        expect(outcome.result).toEqual({ status: 200, body: '{"ok":true}' });
        expect(transport.requests).toHaveLength(1);
        // A GET carries no body: an empty one is still an entity `fetch` rejects.
        expect(transport.requests[0]?.body).toBeUndefined();
      },
    );
  });

  it("refuses a host that is not listed, and never sends the request", async () => {
    const transport = createFakeTransport([jsonResponse("{}")]);
    await withFixture(
      {
        transport,
        policy: accessPolicy({
          allowed: ["network.connect"],
          networkEnabled: true,
          allowedHosts: ["*.example.com"],
        }),
      },
      async (subject) => {
        const refusal = await subject.sandbox.admit({
          kind: "network.request",
          url: "https://evil.test/steal",
          method: "GET",
        });
        expect(refusal?.reasonCode).toBe("TARGET_NOT_ALLOWED");
        const performed = await subject.sandbox.perform({
          kind: "network.request",
          url: "https://evil.test/steal",
          method: "GET",
        });
        expect(performed.ok).toBe(false);
        expect(transport.requests).toHaveLength(0);
      },
    );
  });

  it("refuses an unusable URL before considering the host", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["network.connect"],
          networkEnabled: true,
          allowedHosts: ["example.com"],
        }),
      },
      async (subject) => {
        for (const url of [
          "file:///etc/passwd",
          "https://user:password@example.com/x",
          "not-a-url",
          "/relative/path",
        ]) {
          const refusal = await subject.sandbox.admit({
            kind: "network.request",
            url,
            method: "GET",
          });
          expect(refusal?.reasonCode, url).toBe("TARGET_REFUSED");
        }
      },
    );
  });

  it("keeps operation hosts and provider hosts apart, in both directions", async () => {
    const transport = createFakeTransport([
      jsonResponse("provider"),
      jsonResponse("operation"),
    ]);
    await withFixture(
      {
        transport,
        policy: accessPolicy({
          allowed: ["network.connect"],
          networkEnabled: true,
          allowedHosts: ["api.operations.test"],
          providerHosts: ["api.provider.test"],
        }),
      },
      async (subject) => {
        const { providerTransport } = subject.sandbox.network;

        // The provider transport refuses an operation host…
        await expect(
          providerTransport.send({
            url: "https://api.operations.test/v1",
            method: "GET",
            headers: {},
            timeoutMs: 1_000,
            correlationId: "test",
          }),
        ).rejects.toThrow();

        // …and an operation refuses a provider host.
        const refusal = await subject.sandbox.admit({
          kind: "network.request",
          url: "https://api.provider.test/v1/chat",
          method: "POST",
        });
        expect(refusal?.reasonCode).toBe("TARGET_NOT_ALLOWED");

        // The provider's own host works, so the separation is not simply "nothing".
        const response = await providerTransport.send({
          url: "https://api.provider.test/v1/chat",
          method: "POST",
          headers: {},
          body: "{}",
          timeoutMs: 1_000,
          correlationId: "test",
        });
        expect(response.body).toBe("provider");
      },
    );
  });

  it("reports a provider refusal without a header, query string or body", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["network.connect"],
          networkEnabled: true,
          providerHosts: [],
        }),
      },
      async (subject) => {
        const error = await subject.sandbox.network.providerTransport
          .send({
            url: "https://api.provider.test/v1/chat?token=sk-fixture-super-secret-value",
            method: "POST",
            headers: { authorization: `Bearer ${FIXTURE_SECRET_VALUE}` },
            body: JSON.stringify({ key: FIXTURE_SECRET_VALUE }),
            timeoutMs: 1_000,
            correlationId: "test",
          })
          .then(
            () => "no error",
            (thrown: unknown) => String(thrown),
          );
        expect(error).toContain("TARGET_NOT_ALLOWED");
        expect(error).not.toContain(FIXTURE_SECRET_VALUE);
        expect(error).not.toContain("authorization");
        expect(error).not.toContain("token=");
      },
    );
  });

  it("applies the same provider-host check to a streamed request", async () => {
    const transport = createFakeStreamingTransport({
      stream: [{ kind: "stream", frames: ['data: {"ok":true}\n\n'] }],
    });
    await withFixture(
      {
        transport,
        policy: accessPolicy({
          allowed: ["network.connect"],
          networkEnabled: true,
          providerHosts: ["api.provider.test"],
        }),
      },
      async (subject) => {
        const { providerTransport } = subject.sandbox.network;
        const request = {
          url: "https://api.unlisted.test/v1/chat",
          method: "POST" as const,
          headers: {},
          body: "{}",
          timeoutMs: 1_000,
          correlationId: "test",
        };

        // Streaming must not become the one path that reaches a host the project never
        // allowlisted. A guard on `send` beside an unguarded `sendStream` would be
        // exactly that, so the refusal is asserted on the streaming entry point itself.
        await expect(providerTransport.sendStream?.(request)).rejects.toThrow();
        expect(transport.streamRequests).toHaveLength(0);

        // And the allowlisted host still works, so this is a check and not a blanket.
        const stream = await providerTransport.sendStream?.({
          ...request,
          url: "https://api.provider.test/v1/chat",
        });
        expect(stream?.status).toBe(200);
        let text = "";
        for await (const chunk of stream?.chunks ?? []) {
          text += chunk;
        }
        expect(text).toContain("ok");
      },
    );
  });

  it("does not advertise streaming when the wrapped transport cannot stream", async () => {
    const transport = createFakeTransport([jsonResponse("{}")]);
    await withFixture({ transport }, async (subject) => {
      // The guard forwards a capability, it does not manufacture one: a wrapper that
      // always exposed `sendStream` would offer callers something it would then have to
      // fake, and the provider answers "can this transport stream?" by asking it.
      expect(
        subject.sandbox.network.providerTransport.sendStream,
      ).toBeUndefined();
    });
  });
});

describe("sandbox: environment boundary", () => {
  it("reads an allowlisted variable and refuses everything else", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["environment.read"],
          allowedVariables: ["FIXTURE_ALLOWED"],
        }),
      },
      async (subject) => {
        const allowed = await subject.sandbox.perform({
          kind: "env.read",
          name: "FIXTURE_ALLOWED",
        });
        expect(allowed.ok).toBe(true);
        if (!allowed.ok) {
          return;
        }
        expect(allowed.result).toEqual({
          present: true,
          value: "allowed-value",
        });

        const unlisted = await subject.sandbox.admit({
          kind: "env.read",
          name: "PATH",
        });
        expect(unlisted?.reasonCode).toBe("TARGET_NOT_ALLOWED");
      },
    );
  });

  it("answers a refused variable identically to a missing one, so it is not an oracle", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["environment.read"],
          allowedVariables: ["FIXTURE_ALLOWED"],
        }),
      },
      async (subject) => {
        const refused = await subject.sandbox.perform({
          kind: "env.read",
          name: "FIXTURE_SECRET",
        });
        expect(refused.ok).toBe(false);
        // The boundary's own read is indistinguishable from "not present": a
        // refusal must not reveal that a secret exists.
        expect(
          subject.sandbox.environmentBoundary.read("FIXTURE_SECRET"),
        ).toEqual({
          present: false,
        });
        expect(
          subject.sandbox.environmentBoundary.read("FIXTURE_DOES_NOT_EXIST"),
        ).toEqual({ present: false });
      },
    );
  });

  it("lets a denial pattern override the allowlist", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["environment.read"],
          allowedVariables: ["FIXTURE_API_KEY", "FIXTURE_ALLOWED"],
          envDeniedPatterns: ["*_API_KEY"],
        }),
      },
      async (subject) => {
        const refusal = await subject.sandbox.admit({
          kind: "env.read",
          name: "FIXTURE_API_KEY",
        });
        expect(refusal?.reasonCode).toBe("POLICY_DENIED");
      },
    );
  });

  it("refuses a target that is a value rather than a name", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["environment.read"],
          allowedVariables: ["FIXTURE_ALLOWED"],
        }),
      },
      async (subject) => {
        const refusal = await subject.sandbox.admit({
          kind: "env.read",
          name: FIXTURE_SECRET_VALUE,
        });
        expect(refusal?.reasonCode).toBe("TARGET_REFUSED");
      },
    );
  });

  it("offers no way to enumerate the environment", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["environment.read"],
          allowedVariables: ["FIXTURE_ALLOWED"],
        }),
      },
      async (subject) => {
        // The port itself has a single `get(name)`, and the boundary adds one
        // refusal-checked read. There is no `list()`, no `all()` and no snapshot to
        // leak: this assertion is about the shape of the surface, not behaviour.
        expect(Object.keys(subject.sandbox.environmentBoundary).sort()).toEqual(
          ["admitVariable", "id", "read"],
        );
        const child = subject.sandbox.childEnvironmentNames;
        expect(child).not.toContain("FIXTURE_SECRET");
        expect(child).not.toContain("PATH");
      },
    );
  });

  it("never puts a secret value in a refusal message", async () => {
    await withFixture(
      {
        policy: accessPolicy({
          allowed: ["environment.read"],
          allowedVariables: [],
        }),
      },
      async (subject) => {
        const refusal = await subject.sandbox.admit({
          kind: "env.read",
          name: "FIXTURE_SECRET",
        });
        expect(refusal?.reason).not.toContain(FIXTURE_SECRET_VALUE);
        expect(JSON.stringify(refusal)).not.toContain(FIXTURE_SECRET_VALUE);
      },
    );
  });
});
