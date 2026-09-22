import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_TYPESAFE_BASE_URL,
} from "../adapters/config/project-config.js";
import { createDisabledChangeProvider } from "../adapters/git/git-change-provider.js";
import { createFileRepositoryReader } from "../adapters/repository/file-repository-reader.js";
import { createFileAppendLock } from "../adapters/storage/file-append-lock.js";
import { createJsonlEventStore } from "../adapters/storage/jsonl-event-store.js";
import { isSecretShapedPath, parseIgnoreRules } from "../context/ignore.js";
import type { Clock } from "../core/clock.js";
import { isDomainError } from "../core/errors.js";
import {
  createSequentialIdFactory,
  eventId,
  projectId,
  taskId,
  workspaceId,
} from "../core/ids.js";
import { createEvent } from "../observability/events.js";
import type { DomainEvent } from "../observability/events.js";
import { type AccessPolicy, hostAllowedBy } from "../policy/access-policy.js";
import {
  isWithinRoot,
  refWithinAnyRoot,
  resolveRef,
} from "../policy/path-boundary.js";
import { urlHost } from "../adapters/sandbox/guarded-network.js";
import type { OperationRequest } from "../ports/operation.js";
import { createProject } from "../projects/project.js";
import { createWorkspace } from "../workspaces/workspace.js";
import { createDeterministicContextEngine } from "./context-engine.js";
import { createEventRecorder } from "./event-recorder.js";
import {
  type Environment,
  createProcessEnvironment,
  describeCredential,
  formatCredentialPresence,
} from "../ports/environment.js";
import { createImmediateSleep } from "../ports/sleep.js";
import {
  aiDirectory,
  eventsDirectory,
  projectConfigPath,
  runtimeDirectories,
} from "../adapters/storage/layout.js";
import { CONTEXT_ENGINE_INFO, openRuntime } from "./runtime.js";

/**
 * `ai doctor`: verify the local foundation.
 *
 * The guiding rule is that a check must be able to fail for a real reason. Every
 * check below performs the thing it claims to verify — it opens the config,
 * appends and re-reads a real event through the real adapter, and reconstructs a
 * real trace — rather than asserting that a file or symbol merely exists.
 *
 * The command is **offline by construction**: it never calls a provider, because a
 * health check that spends the user's money is not a health check. Verifying a
 * credential means proving it is *present*, not proving a vendor accepts it.
 *
 * Checks that report `warn` rather than `ok` describe deliberate limitations of the
 * current phase — chiefly that no real agent runtime is installed — and pretending
 * otherwise would be the exact dishonesty this command exists to prevent.
 *
 * Credential *values* are never read, printed, hashed or logged; only whether the
 * named variable is set. No other environment variable is inspected.
 * See docs/architecture/V2-ARCHITECTURE.md §24 and DECISIONS.md ADR-021.
 */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly status: DoctorStatus;
  readonly detail?: string;
}

export interface DoctorReport {
  readonly projectRoot: string;
  readonly checks: readonly DoctorCheck[];
  /** Worst status across all checks. */
  readonly status: DoctorStatus;
  readonly failures: number;
  readonly warnings: number;
  /** 0 when no check failed. Warnings do not fail the command. */
  readonly exitCode: number;
}

export interface DoctorDeps {
  readonly projectRoot: string;
  readonly clock: Clock;
  /** Reported verbatim; injected so the compatibility check is testable. */
  readonly runtimeVersion: string;
  readonly platform: string;
  /**
   * Where credentials are looked up — presence only, never the value. Defaults to
   * the process environment; tests inject a fixed one so no real credential can
   * leak into a test run.
   */
  readonly environment?: Environment;
}

const STATUS_RANK: Readonly<Record<DoctorStatus, number>> = {
  ok: 0,
  warn: 1,
  fail: 2,
};

/** Minimum Node major this platform is built and verified against. */
export const MINIMUM_NODE_MAJOR = 24;
/** The exact version this repository's `engines` field pins. */
export const PINNED_NODE_VERSION = [24, 21, 0] as const;

function parseVersion(
  version: string,
): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function checkRuntime(version: string, platform: string): DoctorCheck {
  const parsed = parseVersion(version);
  const detail = `Node ${version} on ${platform}; platform baseline is Node >= ${MINIMUM_NODE_MAJOR}`;
  if (parsed === undefined) {
    return {
      id: "runtime",
      title: "Runtime compatibility",
      status: "warn",
      detail: `could not parse runtime version "${version}"; ${detail}`,
    };
  }
  const [major, minor] = parsed;
  if (major < MINIMUM_NODE_MAJOR) {
    return {
      id: "runtime",
      title: "Runtime compatibility",
      status: "fail",
      detail: `${detail}; upgrade to Node >= ${MINIMUM_NODE_MAJOR}`,
    };
  }
  const [pinnedMajor, pinnedMinor] = PINNED_NODE_VERSION;
  if (major === pinnedMajor && minor < pinnedMinor) {
    return {
      id: "runtime",
      title: "Runtime compatibility",
      status: "warn",
      detail: `${detail}; this repository pins ${PINNED_NODE_VERSION.join(".")}`,
    };
  }
  return {
    id: "runtime",
    title: "Runtime compatibility",
    status: "ok",
    detail,
  };
}

async function checkLayout(projectRoot: string): Promise<DoctorCheck> {
  const missing: string[] = [];
  for (const directory of runtimeDirectories(projectRoot)) {
    try {
      await access(directory);
    } catch {
      missing.push(directory);
    }
  }
  if (missing.length > 0) {
    return {
      id: "layout",
      title: "Runtime directories",
      status: "fail",
      detail: `missing: ${missing.join(", ")}; run \`ai init\` to create the runtime layout`,
    };
  }
  try {
    await access(eventsDirectory(projectRoot), 0o2);
  } catch {
    return {
      id: "layout",
      title: "Runtime directories",
      status: "fail",
      detail: `${eventsDirectory(projectRoot)} is not writable`,
    };
  }
  return {
    id: "layout",
    title: "Runtime directories",
    status: "ok",
    detail: `present and writable under ${aiDirectory(projectRoot)}`,
  };
}

/**
 * Reports which LLM provider is configured and whether it could actually run.
 *
 * Presence of a credential is checked without ever reading, echoing or hashing its
 * value: only the variable name, its length and its last four characters are
 * reported, and only so an operator can confirm they exported the right thing.
 *
 * A configured real provider with no credential is a genuine failure, not a
 * warning: every subsequent run would fail with `auth`, and this command exists to
 * say so before money or time is spent. The offline provider needs no credential
 * and is reported as `ok`.
 */
function checkProvider(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  environment: Environment,
): DoctorCheck {
  const llm = runtime.llm;
  if (llm.provider === "simulated") {
    return {
      id: "llm-provider",
      title: "LLM provider",
      status: "ok",
      detail:
        `offline provider "${runtime.providerId}" serving model ` +
        `"${runtime.modelId}"; no credential or network required`,
    };
  }

  const presence = describeCredential(environment, llm.credentialEnvVar);
  const host = (() => {
    try {
      return new URL(llm.baseUrl).host;
    } catch {
      return "unparseable base URL";
    }
  })();
  const common =
    `"${runtime.providerId}" -> ${host}, model "${llm.modelId}", ` +
    `up to ${llm.maxAttempts ?? "3"} attempt(s)` +
    (llm.timeoutMs === undefined ? "" : `, ${llm.timeoutMs}ms timeout`);
  const egress = providerEgressNote(llm.baseUrl, runtime.accessPolicy);
  if (!presence.present) {
    return {
      id: "llm-provider",
      title: "LLM provider",
      status: "fail",
      detail:
        `${common}; the credential variable ${presence.name} is not set, so every ` +
        `call would fail with \`auth\`. Export it, or set \`llm.provider\` back to ` +
        `"simulated"`,
    };
  }
  if (egress !== undefined) {
    return {
      id: "llm-provider",
      title: "LLM provider",
      status: "warn",
      detail: `${common}; ${formatCredentialPresence(presence)}; ${egress}`,
    };
  }
  return {
    id: "llm-provider",
    title: "LLM provider",
    status: "ok",
    detail: `${common}; ${formatCredentialPresence(presence)}`,
  };
}

/**
 * Whether the platform's own egress may reach the host a provider is configured for.
 *
 * Configuring a provider and making it reachable are two separate decisions: the
 * host must also appear in `policy.network.providerHosts`, and it is checked at the
 * transport rather than by each adapter (ADR-050). A provider whose host is missing
 * is constructible, credentialed and *unreachable* — a state worth naming here,
 * because the alternative is an operator reading `FORBIDDEN` at run time and
 * wondering which of the two halves is wrong.
 *
 * Returns `undefined` when there is nothing to say, which includes an unparseable
 * URL: a bad URL is a configuration error the provider's own validation already
 * refuses loudly, and doctor does not duplicate it.
 */
function providerEgressNote(
  url: string,
  policy: AccessPolicy,
): string | undefined {
  const host = urlHost(url);
  if (host === undefined) {
    return undefined;
  }
  if (hostAllowedBy(policy.network.providerHosts, host) !== undefined) {
    return undefined;
  }
  return (
    `warning: host "${host}" is not listed in policy.network.providerHosts, so ` +
    `every request would be refused by the network boundary before it is sent; ` +
    `add it there to allow provider egress`
  );
}

/**
 * Reports the decision layer, and whether it could actually be used.
 *
 * Offline by construction, like every other check here: a decision provider is
 * *configured*, and its credential is *present* or *absent*. Whether a JEV service
 * answers correctly is not something a health check can establish without spending
 * money and sending data, so it does not pretend to.
 *
 * A configured provider with no credential is a real failure: every consultation
 * would fail with `auth`, the deterministic fallback would answer everything, and an
 * operator would see a working system with a silently dead decision layer. That is
 * exactly the state this command exists to surface.
 */
function checkDecisionLayer(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  environment: Environment,
): DoctorCheck {
  const config = runtime.decision;
  const info = runtime.decisionEngine;
  const budget =
    `${config.maxDecisionsPerTask} consultation(s) per task, ` +
    `${config.maxRetriesPerTask} attempt-level retr(ies)`;
  if (!info.configured) {
    return {
      id: "decision-layer",
      title: "Decision layer",
      status: "ok",
      detail:
        `disabled (${config.provider}); bounded questions are answered by code and ` +
        `recorded as such, and no decision request is sent (${budget})`,
    };
  }

  const kinds = info.kinds ?? [];
  const common =
    `"${info.providerId ?? "unknown"}" (${info.providerFamily ?? "unknown"}) ` +
    `serving ${kinds.length === 0 ? "no" : kinds.join(", ")} question kind(s); ` +
    `${info.deterministic === true ? "declared deterministic" : "not declared deterministic"}; ${budget}`;

  if (config.provider === "disabled") {
    // An injected provider with a disabled configuration is a test or an embedding;
    // there is no configured credential to check and no endpoint to describe.
    return {
      id: "decision-layer",
      title: "Decision layer",
      status: "ok",
      detail: `${common}; injected provider (configuration says disabled)`,
    };
  }

  const presence = describeCredential(environment, config.credentialEnvVar);
  // TypeSafe's own SDK defaults both of these, so an operator only writes what they
  // mean to change. The doctor still names the host that would be reached, because
  // egress policy is checked against a host.
  const baseUrl =
    config.baseUrl ??
    (config.provider === "typesafe" ? DEFAULT_TYPESAFE_BASE_URL : undefined);
  const host = (() => {
    if (baseUrl === undefined) {
      return "unparseable base URL";
    }
    try {
      return new URL(baseUrl).host;
    } catch {
      return "unparseable base URL";
    }
  })();
  const declaredModel =
    config.provider === "typesafe" ? config.defaultModel : config.modelId;
  const transport =
    `-> ${host}` +
    (config.timeoutMs === undefined ? "" : `, ${config.timeoutMs}ms timeout`) +
    (declaredModel === undefined ? "" : `, model "${declaredModel}"`);
  if (!presence.present) {
    return {
      id: "decision-layer",
      title: "Decision layer",
      status: "fail",
      detail:
        `${common}; ${transport}; the credential variable ${presence.name} is not set, ` +
        `so every consultation would fail with \`auth\` and the deterministic fallback ` +
        `would answer. Export it, or set \`decision.provider\` back to "disabled"`,
    };
  }
  const egress =
    baseUrl === undefined
      ? undefined
      : providerEgressNote(baseUrl, runtime.accessPolicy);
  if (egress !== undefined) {
    return {
      id: "decision-layer",
      title: "Decision layer",
      status: "warn",
      detail:
        `${common}; ${transport}; ${formatCredentialPresence(presence)}; ${egress}` +
        ` (the deterministic fallback would answer every question)`,
    };
  }
  return {
    id: "decision-layer",
    title: "Decision layer",
    status: "ok",
    detail: `${common}; ${transport}; ${formatCredentialPresence(presence)}`,
  };
}

/**
 * Reports the model catalog and the frontier routing policy.
 *
 * Two different questions, answered separately, because conflating them is how a
 * project ends up believing it has a working multi-model path when it has a model
 * list and no way to reach it:
 *
 * - **Knowledge** — how many models are registered, and what they can do.
 * - **Reachability** — for each provider, whether the credential variable is set and
 *   whether policy allows its host. Neither answer reveals a credential value, and
 *   neither makes a network request: the default doctor stays offline.
 */
function checkFrontier(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  environment: Environment,
): DoctorCheck {
  const config = runtime.frontierConfig;
  const models = config.models;
  const enabledModels = models.filter((model) => model.enabled);
  const capabilities = [
    ...new Set(models.flatMap((model) => model.capabilities)),
  ].sort();
  const catalog =
    `${models.length} model(s) registered, ${enabledModels.length} enabled, ` +
    `${config.providers.length} provider(s) configured; routing "${config.routing.mode}", ` +
    `at most ${config.routing.maxModelCalls} call(s) and ${config.routing.maxRetriesPerStep} retr(ies) per step, ` +
    `decomposition ${config.routing.allowDecomposition ? "allowed" : "off"}, parallel ${config.routing.allowParallel ? "allowed" : "off"}`;
  if (models.length === 0) {
    return {
      id: "frontier",
      title: "Frontier models",
      status: "warn",
      detail:
        `${catalog}; no model is registered, so no orchestration plan can be built ` +
        `(add entries to frontier.models to describe your models)`,
    };
  }

  if (!config.enabled) {
    return {
      id: "frontier",
      title: "Frontier models",
      status: "ok",
      detail:
        `${catalog}; routing is disabled, so nothing is called and ` +
        `\`ai task orchestrate\` will refuse; capabilities on record: ${capabilities.join(", ")}`,
    };
  }

  const problems: string[] = [];
  const warnings: string[] = [];
  for (const provider of config.providers) {
    const presence = describeCredential(environment, provider.credentialEnvVar);
    const served = models.filter(
      (model) => model.providerId === provider.id && model.enabled,
    );
    if (served.length === 0) {
      continue;
    }
    if (!presence.present) {
      problems.push(
        `provider "${provider.id}": ${presence.name} is not set, so its ` +
          `${served.length} enabled model(s) would fail with \`auth\``,
      );
      continue;
    }
    const egress = providerEgressNote(provider.baseUrl, runtime.accessPolicy);
    if (egress !== undefined) {
      warnings.push(`provider "${provider.id}": ${egress}`);
    }
  }

  const detail =
    `${catalog}; enabled models: ${enabledModels.map((model) => model.modelId).join(", ")}; ` +
    `capabilities: ${capabilities.join(", ")}` +
    (problems.length === 0 ? "" : `; ${problems.join("; ")}`) +
    (warnings.length === 0 ? "" : `; ${warnings.join("; ")}`);

  if (problems.length > 0) {
    return {
      id: "frontier",
      title: "Frontier models",
      status: "fail",
      detail,
    };
  }
  return {
    id: "frontier",
    title: "Frontier models",
    status: warnings.length > 0 ? "warn" : "ok",
    detail,
  };
}

/**
 * Checks the shape of the plans this project has already recorded.
 *
 * A plan event that names a step count it does not have, or a candidate list that
 * does not contain the models it says will run, is a plan nobody can audit after the
 * fact. Checked against real recorded events, and nothing is written.
 */
function checkOrchestrationAudit(events: readonly DomainEvent[]): DoctorCheck {
  const problems: string[] = [];
  let plans = 0;
  for (const event of events) {
    if (event.type !== "OrchestrationPlanned") {
      continue;
    }
    plans += 1;
    const { stepCount, modelIds, strategy, maxModelCalls } = event.payload;
    if (strategy !== "deterministic" && modelIds.length > maxModelCalls) {
      problems.push(
        `plan "${event.payload.planId}" would use ${modelIds.length} model(s) above its ${maxModelCalls} call cap`,
      );
    }
    if (strategy === "deterministic" && stepCount !== 0) {
      problems.push(
        `plan "${event.payload.planId}" is deterministic but declares ${stepCount} step(s)`,
      );
    }
  }
  if (plans === 0) {
    return {
      id: "orchestration-audit",
      title: "Orchestration audit",
      status: "ok",
      detail:
        "no orchestration plan has been recorded in this workspace yet; nothing to check",
    };
  }
  return {
    id: "orchestration-audit",
    title: "Orchestration audit",
    status: problems.length === 0 ? "ok" : "fail",
    detail:
      problems.length === 0
        ? `${plans} recorded plan(s) are internally consistent (step counts, call caps, candidate lists)`
        : `${plans} recorded plan(s); problems: ${problems.join("; ")}`,
  };
}

/**
 * Checks the shape of the decisions this project has already recorded.
 *
 * These are the invariants that make the decision log usable after the fact, checked
 * against real recorded events rather than against a constructed example: a decision
 * that cannot be tied to its question, or a fallback that does not say why it was
 * used, is a decision nobody can audit. Nothing is written by this check.
 */
function checkDecisionAudit(events: readonly DomainEvent[]): DoctorCheck {
  const problems: string[] = [];
  let decisions = 0;
  let fallbacks = 0;
  let failures = 0;
  for (const event of events) {
    if (event.type === "DecisionFailed") {
      failures += 1;
      if (event.payload.providerId.length === 0) {
        problems.push(
          `DecisionFailed event "${event.id}" does not name a provider`,
        );
      }
      continue;
    }
    if (event.type !== "DecisionCompleted") {
      continue;
    }
    decisions += 1;
    if (
      event.payload.answeredBy === "fallback" &&
      event.payload.fallbackReason === undefined
    ) {
      problems.push(
        `decision "${event.payload.decisionId}" used a fallback without recording why`,
      );
    }
    if (event.payload.answeredBy === "fallback") {
      fallbacks += 1;
    }
    if (
      event.payload.answeredBy === "provider" &&
      event.payload.providerId === undefined
    ) {
      problems.push(
        `decision "${event.payload.decisionId}" was answered by a provider that is not named`,
      );
    }
  }
  const detail =
    `${decisions} decision(s) recorded, ${fallbacks} answered by the deterministic ` +
    `fallback, ${failures} failed consultation(s)`;
  if (problems.length > 0) {
    return {
      id: "decision-audit",
      title: "Decision audit",
      status: "fail",
      detail: `${detail}; ${problems.join("; ")}`,
    };
  }
  return {
    id: "decision-audit",
    title: "Decision audit",
    status: "ok",
    detail:
      decisions === 0
        ? `${detail}; the decision path has not been exercised in this scope yet`
        : detail,
  };
}

/**
 * Exercises append coordination for real: hold this project's lock, then try to
 * take it again from a second writer.
 *
 * The second writer must be refused with `LOCK_TIMEOUT`, and the lock file must be
 * gone afterwards. Both halves matter — a lock that is never released is worse than
 * no lock, because it looks like coordination while wedging the stream.
 */
async function checkAppendLock(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  clock: Clock,
  projectRoot: string,
): Promise<DoctorCheck> {
  const directory = eventsDirectory(projectRoot);
  const probeKey = "doctor-lock-probe";
  const lockFile = join(directory, `.${probeKey}.lock`);
  try {
    const contender = createFileAppendLock({
      directory,
      clock,
      sleep: createImmediateSleep(),
      lockTimeoutMs: 1,
      pollIntervalMs: 1,
      id: "doctor-contender",
    });
    let refused = false;
    let refusalCode: string | undefined;
    await runtime.lock.withLock(probeKey, async () => {
      try {
        await contender.withLock(probeKey, async () => undefined, {
          timeoutMs: 1,
        });
      } catch (error) {
        refusalCode = isDomainError(error) ? error.code : "unknown";
        refused = refusalCode === "LOCK_TIMEOUT";
      }
    });

    let leaked: boolean;
    try {
      await access(lockFile);
      leaked = true;
    } catch {
      leaked = false;
    }

    if (!refused) {
      return {
        id: "append-lock",
        title: "Append coordination",
        status: "fail",
        detail:
          `a second writer was not refused while this one held "${probeKey}" ` +
          `(got ${refusalCode ?? "no error"}); two writers could append the same sequence`,
      };
    }
    if (leaked) {
      return {
        id: "append-lock",
        title: "Append coordination",
        status: "fail",
        detail: `the lock file ${lockFile} survived release; the stream would stay wedged`,
      };
    }
    return {
      id: "append-lock",
      title: "Append coordination",
      status: runtime.lockGuarantee === "none" ? "warn" : "ok",
      detail:
        `"${runtime.lockId}" (${runtime.lockGuarantee}); a concurrent writer was ` +
        `refused and the lock was released`,
    };
  } catch (error) {
    return {
      id: "append-lock",
      title: "Append coordination",
      status: "fail",
      detail: isDomainError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    };
  }
}

/**
 * Appends and re-reads a real event through the real adapter, in a throwaway
 * directory so the project's own log is never polluted by a health check. Also
 * verifies that a foreign workspace scope is rejected, because "can I write?"
 * matters less than "can I write somewhere I should not?".
 */
async function checkEventStore(clock: Clock): Promise<DoctorCheck> {
  const probeRoot = await mkdtemp(join(tmpdir(), "ai-doctor-"));
  try {
    const probeProject = projectId("doctor-probe");
    const probeWorkspace = workspaceId("doctor-probe-workspace");
    const probeTask = taskId("doctor-probe-task");
    const store = createJsonlEventStore({
      projectRoot: probeRoot,
      projectId: probeProject,
      knownWorkspaceIds: [probeWorkspace],
    });
    const probe = createEvent(
      {
        type: "TaskCreated",
        actor: { type: "system", id: "ai-doctor" },
        projectId: probeProject,
        workspaceId: probeWorkspace,
        taskId: probeTask,
        payload: {
          title: "doctor probe",
          riskLevel: "low",
          workspaceId: probeWorkspace,
        },
      },
      { id: eventId("doctor-probe-event"), sequence: 1, clock },
    );
    await store.append(probe);
    const readBack = await store.readByTask(
      { projectId: probeProject, workspaceId: probeWorkspace },
      probeTask,
    );
    if (readBack.length !== 1 || readBack[0].id !== probe.id) {
      return {
        id: "event-store",
        title: "Event store append/read",
        status: "fail",
        detail: `wrote 1 event and read back ${readBack.length}`,
      };
    }

    let foreignRejected = false;
    try {
      await store.readByTask(
        { projectId: probeProject, workspaceId: workspaceId("foreign-ws") },
        probeTask,
      );
    } catch (error) {
      foreignRejected = isDomainError(error) && error.code === "FORBIDDEN";
    }
    if (!foreignRejected) {
      return {
        id: "event-store",
        title: "Event store append/read",
        status: "fail",
        detail:
          "a foreign workspace scope was accepted; isolation is not enforced by the event store",
      };
    }

    return {
      id: "event-store",
      title: "Event store append/read",
      status: "ok",
      detail: `round trip ok; foreign workspace scope rejected (probe: ${probeRoot})`,
    };
  } catch (error) {
    return {
      id: "event-store",
      title: "Event store append/read",
      status: "fail",
      detail: isDomainError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    };
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

/**
 * Reports the context configuration and whether it agrees with this build.
 *
 * The strategy and version are compared against the code's own constants rather
 * than merely printed: a project configured for selection version 2 read by a build
 * that implements version 1 would silently make every recorded selection
 * unattributable, and this check is the only place that can notice.
 */
function checkContextConfig(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
): DoctorCheck {
  const config = runtime.contextConfig;
  const mismatch =
    config.strategy !== CONTEXT_ENGINE_INFO.strategy ||
    config.version !== CONTEXT_ENGINE_INFO.selectionVersion;
  return {
    id: "context-config",
    title: "Context configuration",
    status: mismatch ? "fail" : "ok",
    detail: mismatch
      ? `configured strategy/version "${config.strategy}" v${config.version} does not match this build ` +
        `("${CONTEXT_ENGINE_INFO.strategy}" v${CONTEXT_ENGINE_INFO.selectionVersion})`
      : `strategy "${config.strategy}" v${config.version} (fingerprint ${runtime.context.info.configFingerprint}); ` +
        `budget ${config.maxTokens} tokens, ${config.bytesPerToken} bytes/token, ` +
        `max ${config.maxFileTokens} tokens/file, git changes ${config.useGitChanges ? "on" : "off"}`,
  };
}

/**
 * Checks that the workspace can actually be enumerated and its ignore rules read.
 *
 * No model is called and no provider is contacted: discovery is filesystem work,
 * and a health check that spent money would not be a health check (ADR-021).
 * Change detection is reported as what it is — available or unavailable with a
 * reason — because "no changes" and "could not look" are different facts.
 */
async function checkContextRepository(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
): Promise<DoctorCheck> {
  try {
    const listing = await runtime.reader.list();
    const ignoreText = await runtime.reader.tryRead(".gitignore");
    const rules =
      ignoreText === undefined ? 0 : parseIgnoreRules(ignoreText).length;
    const changes = await runtime.changeProvider.changedRefs();
    const changeDetail = changes.available
      ? `${(changes.refs ?? []).length} changed path(s)` +
        (changes.revision === undefined ? "" : ` at ${changes.revision}`)
      : `unavailable (${String(changes.reason)})`;
    const ignoreDetail =
      ignoreText === undefined ? "no .gitignore" : `${rules} ignore rule(s)`;
    return {
      id: "context-repository",
      title: "Context discovery",
      status: listing.entries.length === 0 ? "warn" : "ok",
      detail:
        listing.entries.length === 0
          ? `"${runtime.reader.id}" found no readable file under ${runtime.workspace.rootPath}; ` +
            "every selection would be empty"
          : `"${runtime.reader.id}" enumerated ${listing.entries.length} file(s)` +
            `${listing.truncated ? " (capped)" : ""}; ${ignoreDetail}; ` +
            `changes via "${runtime.changeProvider.id}": ${changeDetail}`,
    };
  } catch (error) {
    return {
      id: "context-repository",
      title: "Context discovery",
      status: "fail",
      detail: isDomainError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    };
  }
}

/**
 * Runs a real selection against a throwaway workspace and checks the properties
 * that matter, rather than asserting that an engine object exists.
 *
 * It is exercised in a temporary directory for the same reason `checkEventStore`
 * is: a health check must never append probe events to the project's own log. The
 * fixture deliberately contains `.env`, a private key and a directory named like
 * secrets, so "secrets are excluded" is measured on files that are really there.
 *
 * Four properties are verified: discovery finds the referenced file, an explicitly
 * referenced path is mandatory, no secret-shaped path survives selection or
 * exclusion, and a budget too small for the mandatory file is refused loudly
 * (`budgetExceeded`, empty bundle) instead of quietly dropping it.
 */
async function checkContextEngine(clock: Clock): Promise<DoctorCheck> {
  const probeRoot = await mkdtemp(join(tmpdir(), "ai-doctor-context-"));
  try {
    const fixtures: readonly (readonly [string, string])[] = [
      ["src/alpha.ts", "export const alpha = 1;\n"],
      ["src/alpha.test.ts", "import './alpha.js';\n"],
      ["docs/architecture/ADR-001-alpha.md", "# Alpha architecture\n"],
      [".gitignore", "ignored.txt\n"],
      ["ignored.txt", "ignored\n"],
      [".env", "API_KEY=super-secret-value\n"],
      ["config/.env.local", "TOKEN=super-secret-value\n"],
      ["keys/id_rsa", "-----BEGIN PRIVATE KEY-----\n"],
    ];
    for (const [ref, content] of fixtures) {
      const path = join(probeRoot, ...ref.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }

    // Domain factories rather than object literals: the probe project must be a
    // *valid* project, and hand-written shapes silently rot as the domain changes.
    const probeProject = createProject(
      {
        name: "doctor context probe",
        slug: "doctor-context-probe",
        rootPath: probeRoot,
      },
      { id: projectId("doctor-context-project"), clock },
    );
    const probeWorkspace = createWorkspace(
      { name: "doctor context probe", rootPath: probeRoot },
      {
        id: workspaceId("doctor-context-workspace"),
        project: probeProject,
        clock,
      },
    );

    const store = createJsonlEventStore({
      projectRoot: probeRoot,
      projectId: probeProject.id,
      knownWorkspaceIds: [probeWorkspace.id],
    });
    const engine = createDeterministicContextEngine({
      reader: createFileRepositoryReader({ rootPath: probeRoot }),
      changes: createDisabledChangeProvider("doctor-change-probe"),
      recorder: createEventRecorder({
        store,
        projectId: probeProject.id,
        clock,
        eventIds: createSequentialIdFactory("doctor-context-event"),
      }),
      clock,
      config: DEFAULT_CONTEXT_CONFIG,
      project: probeProject,
      workspace: probeWorkspace,
      selectionIds: createSequentialIdFactory("doctor-selection"),
      engineId: "doctor-context-probe",
    });

    const probe = await engine.select({
      taskText: ["change src/alpha.ts"],
      explicitPaths: ["src/alpha.ts"],
      budgetTokens: 512,
    });

    const refused = !probe.selection.selected.some(
      (candidate) => candidate.ref === "src/alpha.ts" && candidate.mandatory,
    );
    if (refused) {
      return {
        id: "context-engine",
        title: "Context selection",
        status: "fail",
        detail:
          "an explicitly referenced file was not selected as mandatory; the engine " +
          "is not honouring the task's own references",
      };
    }
    const leaked = [...probe.selection.selected, ...probe.selection.excluded]
      .map((candidate) => candidate.ref)
      .filter((ref) => isSecretShapedPath(ref));
    if (leaked.length > 0) {
      return {
        id: "context-engine",
        title: "Context selection",
        status: "fail",
        detail: `secret-shaped paths survived selection: ${leaked.join(", ")}`,
      };
    }
    if (
      probe.selection.excludedByRules === 0 ||
      probe.selection.selectedTokens > probe.selection.budgetTokens
    ) {
      return {
        id: "context-engine",
        title: "Context selection",
        status: "fail",
        detail:
          `exclusion or budget enforcement failed: ${probe.selection.excludedByRules} path(s) excluded by rules, ` +
          `${probe.selection.selectedTokens}/${probe.selection.budgetTokens} tokens selected`,
      };
    }

    const tiny = await engine.select({
      taskText: ["change src/alpha.ts"],
      explicitPaths: ["src/alpha.ts"],
      budgetTokens: 1,
    });
    if (!tiny.selection.budgetExceeded || tiny.bundle.items.length !== 0) {
      return {
        id: "context-engine",
        title: "Context selection",
        status: "fail",
        detail:
          "a budget too small for explicitly referenced context was not refused " +
          `(budgetExceeded=${String(tiny.selection.budgetExceeded)}, bundle=${tiny.bundle.items.length})`,
      };
    }

    return {
      id: "context-engine",
      title: "Context selection",
      status: "ok",
      detail:
        `selection ran offline: ${probe.selection.selected.length}/${probe.selection.considered} candidate(s), ` +
        `${probe.selection.selectedTokens}/${probe.selection.budgetTokens} tokens, ` +
        `${probe.selection.excludedByRules} path(s) excluded by rules, secrets refused, ` +
        "over-budget refused (probe: temporary workspace)",
    };
  } catch (error) {
    return {
      id: "context-engine",
      title: "Context selection",
      status: "fail",
      detail: isDomainError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    };
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

/**
 * Offline verification of the enforcement boundary.
 *
 * Everything here is measured rather than asserted, and none of it performs an
 * operation: `admit` is the boundary's own read-only pre-check, so the probes below
 * prove that refusal works without writing a file or starting a process. Four kinds
 * of problem are looked for:
 *
 * - a configured root that escapes the workspace, in text or through a symlink;
 * - refusals that no longer happen: traversal, absolute paths, credential-shaped
 *   paths and runtime state are probed directly, and any one of them being admitted
 *   is a hard failure rather than a warning;
 * - a policy that is self-contradictory, e.g. reads allowed with no readable root;
 * - a capability envelope that is empty (nothing can be done) or unusually wide
 *   (writes or process execution without approval), reported as a warning because
 *   it may be exactly what the operator intended.
 *
 * What this check deliberately cannot say is that the boundary is strong. It is an
 * in-process boundary, not a container, a VM or a kernel-level one, and the detail
 * line says so rather than implying more (ADR-045).
 */
async function checkEnforcement(
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  platform: string,
): Promise<DoctorCheck> {
  const policy = runtime.accessPolicy;
  const boundary = runtime.sandbox;
  const envelope = runtime.operations.envelope;
  const problems: string[] = [];
  const notes: string[] = [];

  const roots: readonly { readonly dir: string; readonly ref: string }[] = [
    ...policy.filesystem.readableRoots.map((ref) => ({ dir: "readable", ref })),
    ...policy.filesystem.writableRoots.map((ref) => ({ dir: "writable", ref })),
  ];
  let realWorkspace: string | undefined;
  try {
    realWorkspace = await realpath(runtime.workspace.rootPath);
  } catch {
    // A workspace that cannot be resolved is reported by the layout and context
    // checks; there is nothing to compare roots against here.
    realWorkspace = undefined;
  }
  for (const { dir, ref } of roots) {
    let absolute: string | undefined;
    try {
      absolute = resolveRef(runtime.workspace.rootPath, ref);
    } catch {
      problems.push(
        `the ${dir} root "${ref}" is not a workspace-relative reference`,
      );
      continue;
    }
    if (!isWithinRoot(runtime.workspace.rootPath, absolute, platform)) {
      problems.push(`the ${dir} root "${ref}" resolves outside the workspace`);
      continue;
    }
    let realRootPath: string | undefined;
    try {
      realRootPath = await realpath(absolute);
    } catch {
      // Not existing yet is normal for a writable root.
      realRootPath = undefined;
    }
    if (
      realRootPath !== undefined &&
      realWorkspace !== undefined &&
      !isWithinRoot(realWorkspace, realRootPath, platform)
    ) {
      problems.push(
        `the ${dir} root "${ref}" is a link that leaves the workspace`,
      );
    }
  }

  const probes: readonly {
    readonly label: string;
    readonly request: OperationRequest;
    readonly expect: readonly string[];
  }[] = [
    {
      label: "parent-directory traversal",
      request: { kind: "fs.read", ref: "../outside.txt" },
      expect: ["TARGET_REFUSED"],
    },
    {
      label: "absolute path",
      request: { kind: "fs.read", ref: "/etc/passwd" },
      expect: ["TARGET_REFUSED"],
    },
    {
      label: "credential-shaped path",
      request: { kind: "fs.read", ref: ".env" },
      expect: ["SECRET_PATH_DENIED"],
    },
    {
      label: "runtime-state write",
      request: { kind: "fs.write", ref: ".ai/project.json", content: "" },
      expect: ["RUNTIME_STATE_DENIED"],
    },
  ];
  for (const probe of probes) {
    const refusal = await boundary.admit(probe.request);
    if (refusal === undefined) {
      problems.push(`the boundary admitted ${probe.label}`);
      continue;
    }
    if (!probe.expect.includes(refusal.reasonCode)) {
      problems.push(
        `${probe.label} was refused as "${refusal.reasonCode}", not as ${probe.expect.join(" or ")}`,
      );
    }
  }

  // The normal path, checked only when policy says it should work: a boundary that
  // contradicts its own policy is worse than one that is merely restrictive.
  if (
    envelope.includes("filesystem.read") &&
    refWithinAnyRoot(".", policy.filesystem.readableRoots) !== undefined
  ) {
    const admitted = await boundary.admit({ kind: "fs.list", ref: "." });
    if (admitted !== undefined) {
      problems.push(
        `reading the workspace root is permitted by policy but refused by the boundary (${admitted.reasonCode})`,
      );
    }
  }

  if (envelope.length === 0) {
    notes.push(
      "the capability envelope is empty: this workspace can plan and record, but no operation can be performed",
    );
  }
  for (const capability of ["filesystem.write", "process.execute"] as const) {
    if (
      envelope.includes(capability) &&
      !policy.capabilities.requireApproval.includes(capability)
    ) {
      notes.push(`${capability} is allowed without human approval`);
    }
  }
  if (policy.network.enabled) {
    notes.push(
      `network access is enabled for ${policy.network.allowedHosts.length} host(s) ` +
        `(${policy.network.providerHosts.length} provider host(s) kept separate)`,
    );
  }
  if (policy.process.allowedCommands.length > 0) {
    notes.push(
      `${policy.process.allowedCommands.length} command(s) may be executed with ` +
        `${policy.process.environmentAllowlist.length} environment variable(s) forwarded`,
    );
  }

  const detail =
    `${boundary.id} (${runtime.operations.guarantee}, not a container or VM); ` +
    `policy ${policy.id} v${policy.version}; ` +
    `capabilities: ${envelope.length === 0 ? "none" : envelope.join(", ")}; ` +
    `refusal probes: ${probes.length} checked`;
  if (problems.length > 0) {
    return {
      id: "enforcement",
      title: "Enforcement boundary",
      status: "fail",
      detail: `${detail}; ${problems.join("; ")}`,
    };
  }
  return {
    id: "enforcement",
    title: "Enforcement boundary",
    status: notes.length === 0 ? "ok" : "warn",
    detail:
      notes.length === 0
        ? `${detail}; no writable root, no command and no host is configured`
        : `${detail}; ${notes.join("; ")}`,
  };
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkRuntime(deps.runtimeVersion, deps.platform),
  ];

  let runtime;
  try {
    runtime = await openRuntime({
      projectRoot: deps.projectRoot,
      clock: deps.clock,
    });
  } catch (error) {
    checks.push({
      id: "project-config",
      title: "Project configuration",
      status: "fail",
      detail: isDomainError(error)
        ? `${error.code}: ${error.message}`
        : `could not read ${projectConfigPath(deps.projectRoot)}: ${String(error)}`,
    });
    return summarize(deps.projectRoot, checks);
  }

  checks.push({
    id: "project-config",
    title: "Project configuration",
    status: "ok",
    detail: `project "${runtime.project.slug}" (${runtime.project.id}) at ${projectConfigPath(deps.projectRoot)}`,
  });

  const workspaceIssue = runtime.workspace.status !== "ready";
  checks.push({
    id: "workspace",
    title: "Workspace",
    status: workspaceIssue ? "warn" : "ok",
    detail: workspaceIssue
      ? `workspace "${runtime.workspace.name}" (${runtime.workspace.id}) is "${runtime.workspace.status}", not "ready"`
      : `workspace "${runtime.workspace.name}" (${runtime.workspace.id}) is ready; ${runtime.config.workspaces.length} configured`,
  });

  checks.push(await checkLayout(deps.projectRoot));

  const scope = {
    projectId: runtime.project.id,
    workspaceId: runtime.workspace.id,
  };
  checks.push(await checkEventStore(deps.clock));
  checks.push(await checkAppendLock(runtime, deps.clock, deps.projectRoot));
  checks.push(
    checkProvider(runtime, deps.environment ?? createProcessEnvironment()),
  );

  try {
    const states = await runtime.ledger.list({ projectId: runtime.project.id });
    const count = (status: string): number =>
      states.filter((state) => state.status === status).length;
    checks.push({
      id: "approvals",
      title: "Approval ledger",
      status: "ok",
      detail:
        `${states.length} approval(s) projected from the log: ` +
        `${count("pending")} pending, ${count("granted")} granted and unused, ` +
        `${count("consumed")} consumed, ${count("expired")} expired`,
    });
  } catch (error) {
    checks.push({
      id: "approvals",
      title: "Approval ledger",
      status: "fail",
      detail: isDomainError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    });
  }

  let eventCount = 0;
  try {
    const events = await runtime.store.readAll(scope);
    eventCount = events.length;
    checks.push({
      id: "event-log",
      title: "Project event log",
      status: "ok",
      detail: `${eventCount} event(s) readable in workspace "${runtime.workspace.id}"`,
    });
    checks.push(checkDecisionAudit(events));
    checks.push(checkOrchestrationAudit(events));
  } catch (error) {
    checks.push({
      id: "event-log",
      title: "Project event log",
      status: "fail",
      detail: isDomainError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    });
  }

  try {
    const traced = await runtime.store.listTaskIds(scope);
    const tracedId = traced[0] ?? taskId("doctor-probe-trace");
    const trace = await runtime.traces.read(scope, tracedId);
    checks.push({
      id: "trace",
      title: "Trace reconstruction",
      status: trace.integrity.ok ? "ok" : "fail",
      detail: trace.integrity.ok
        ? traced.length === 0
          ? `reconstruction path verified on an empty trace; no tasks recorded yet (${eventCount} event(s) in scope)`
          : `task "${tracedId}" reconstructed from ${trace.events.length} event(s): status "${trace.status}", ${trace.llmCalls.length} LLM call(s)`
        : `trace "${tracedId}" is not internally consistent: ${trace.integrity.issues.join("; ")}`,
    });
  } catch (error) {
    checks.push({
      id: "trace",
      title: "Trace reconstruction",
      status: "fail",
      detail: isDomainError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    });
  }

  checks.push(
    checkDecisionLayer(runtime, deps.environment ?? createProcessEnvironment()),
  );
  checks.push(
    checkFrontier(runtime, deps.environment ?? createProcessEnvironment()),
  );
  checks.push(await checkEnforcement(runtime, deps.platform));
  checks.push(checkContextConfig(runtime));
  checks.push(await checkContextRepository(runtime));
  checks.push(await checkContextEngine(deps.clock));

  checks.push({
    id: "agent-runtime",
    title: "Agent runtime",
    status: runtime.runner.kind === "simulated" ? "warn" : "ok",
    detail:
      runtime.runner.kind === "simulated"
        ? `"${runtime.runner.id}" is a deterministic offline stand-in; no real agent runtime is installed`
        : `"${runtime.runner.id}" (${runtime.runner.kind})`,
  });

  checks.push({
    id: "llm-pricing",
    title: "Model pricing",
    status: runtime.modelRates.length === 0 ? "warn" : "ok",
    detail:
      runtime.modelRates.length === 0
        ? "no model rates configured; calls will be reported as unpriced, never as $0"
        : `${runtime.modelRates.length} rate(s) configured for provider "${runtime.providerId}"`,
  });

  return summarize(deps.projectRoot, checks);
}

export function summarize(
  projectRoot: string,
  checks: readonly DoctorCheck[],
): DoctorReport {
  let status: DoctorStatus = "ok";
  let failures = 0;
  let warnings = 0;
  for (const check of checks) {
    if (STATUS_RANK[check.status] > STATUS_RANK[status]) {
      status = check.status;
    }
    if (check.status === "fail") {
      failures += 1;
    } else if (check.status === "warn") {
      warnings += 1;
    }
  }
  return {
    projectRoot,
    checks,
    status,
    failures,
    warnings,
    exitCode: failures === 0 ? 0 : 1,
  };
}

const STATUS_LABEL: Readonly<Record<DoctorStatus, string>> = {
  ok: "ok",
  warn: "warn",
  fail: "FAIL",
};

/** Human-readable report. Presentation only; `--json` is the stable contract. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`ai doctor — ${report.projectRoot}`, ""];
  for (const check of report.checks) {
    lines.push(`[${STATUS_LABEL[check.status]}] ${check.title}`);
    if (check.detail !== undefined) {
      lines.push(`       ${check.detail}`);
    }
  }
  lines.push(
    "",
    `${report.checks.length} check(s): ${report.failures} failed, ${report.warnings} warning(s)`,
  );
  if (report.exitCode !== 0) {
    lines.push("The foundation is not healthy; see failures above.");
  }
  return lines.join("\n");
}
