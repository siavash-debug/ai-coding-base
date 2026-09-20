import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmConfig } from "../../src/adapters/config/project-config.js";
import { type Clock, createFixedClock } from "../../src/core/clock.js";
import {
  initializeProject,
  openRuntime,
} from "../../src/application/runtime.js";
import type { Runtime } from "../../src/application/runtime.js";
import { projectId, workspaceId } from "../../src/core/ids.js";
import { createFileAppendLock } from "../../src/adapters/storage/file-append-lock.js";
import { eventsDirectory } from "../../src/adapters/storage/layout.js";
import type { AppendLock } from "../../src/ports/append-lock.js";
import type { Environment } from "../../src/ports/environment.js";
import type { HttpTransport } from "../../src/ports/http-transport.js";
import type { LlmProvider } from "../../src/ports/llm-provider.js";
import type { Sleep } from "../../src/ports/sleep.js";
import { createRecordingSleep } from "../../src/ports/sleep.js";

/**
 * A real, temporary, fully initialized project.
 *
 * These tests exercise the filesystem adapters, so they use a real directory under
 * the OS temp dir rather than an in-memory fake. Everything about it is still
 * deterministic: a fixed clock, offline adapters, no network, and a unique root
 * that is removed afterwards. The project and workspace ids are generated, so
 * assertions derive ids from the runtime instead of hardcoding them.
 */
export const FIXED_INSTANT = "2026-09-20T10:00:00.000Z";

export interface TestProject {
  readonly root: string;
  readonly runtime: Runtime;
  readonly cleanup: () => Promise<void>;
}

export interface TestProjectOptions {
  readonly clock?: Clock;
  readonly includeRetry?: boolean;
  /** Written into the project configuration at `ai init` time. */
  readonly llm?: LlmConfig;
  /** Overrides the configured provider, for provider-level tests. */
  readonly provider?: LlmProvider;
  readonly lock?: AppendLock;
  readonly sleep?: Sleep;
  readonly environment?: Environment;
  /** Injected so a real provider adapter can be driven without a network. */
  readonly transport?: HttpTransport;
}

export async function createTestProject(
  options?: TestProjectOptions,
): Promise<TestProject> {
  const root = await mkdtemp(join(tmpdir(), "ai-test-"));
  const clock = options?.clock ?? createFixedClock(FIXED_INSTANT);
  await initializeProject({
    projectRoot: root,
    name: "Test Project",
    slug: "test-project",
    clock,
    ...(options?.llm === undefined ? {} : { llm: options.llm }),
  });
  const runtime = await openRuntime({
    projectRoot: root,
    clock,
    ...(options?.includeRetry === undefined
      ? {}
      : { includeRetry: options.includeRetry }),
    ...(options?.provider === undefined ? {} : { provider: options.provider }),
    ...(options?.lock === undefined ? {} : { lock: options.lock }),
    ...(options?.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options?.environment === undefined
      ? {}
      : { environment: options.environment }),
    ...(options?.transport === undefined
      ? {}
      : { transport: options.transport }),
  });
  return {
    root,
    runtime,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * A lock that records how long it was asked to wait, so lock behaviour is
 * assertable without waiting. The real algorithm is unchanged; only the clock and
 * the sleeping are faked, exactly as `openRuntime` allows.
 */
export function createTestLock(input: {
  readonly projectRoot: string;
  readonly clock: Clock;
}): AppendLock {
  return createFileAppendLock({
    directory: eventsDirectory(input.projectRoot),
    clock: input.clock,
    sleep: createRecordingSleep(),
    id: "test-file-lock",
  });
}

/**
 * A clock that advances a fixed step on every read.
 *
 * Time is still injected and fully deterministic, but latency measurements are
 * non-zero, which is what makes latency accounting observable in a test without
 * ever consulting the wall clock.
 */
export function createTickingClock(start = FIXED_INSTANT, stepMs = 250): Clock {
  let current = Date.parse(start);
  return {
    now: () => {
      const instant = new Date(current);
      current += stepMs;
      return instant;
    },
  };
}

export const TEST_PROJECT_ID = projectId("prj-isolation-a");
export const TEST_WORKSPACE_ID = workspaceId("wsp-isolation-a");
