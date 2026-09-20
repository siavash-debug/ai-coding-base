import { access, mkdir } from "node:fs/promises";

import type { Clock } from "../core/clock.js";
import { createSystemClock } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import { type WorkspaceId, createUuidIdFactory } from "../core/ids.js";
import { defaultPolicy } from "../decisions/policy.js";
import { createSimulatedAgentRunner } from "../adapters/agent/simulated-agent-runner.js";
import {
  CONTEXT_SELECTION_VERSION,
  CONTEXT_STRATEGY,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_LLM_CONFIG,
  type ContextConfig,
  type LlmConfig,
  type ProjectConfig,
  ensureRuntimeLayout,
  isMissingFile,
  readProjectConfig,
  writeProjectConfig,
} from "../adapters/config/project-config.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProvider,
} from "../adapters/llm/openai-compatible-provider.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  createRetryingProvider,
} from "../adapters/llm/retrying-provider.js";
import { createFetchTransport } from "../adapters/http/fetch-transport.js";
import {
  createDisabledChangeProvider,
  createGitChangeProvider,
} from "../adapters/git/git-change-provider.js";
import { createNodeProcessRunner } from "../adapters/process/node-process-runner.js";
import { createFileRepositoryReader } from "../adapters/repository/file-repository-reader.js";
import { createFileAppendLock } from "../adapters/storage/file-append-lock.js";
import { createTimerSleep } from "../adapters/time/timer-sleep.js";
import { createProcessEnvironment } from "../ports/environment.js";
import type { Environment } from "../ports/environment.js";
import type { HttpTransport } from "../ports/http-transport.js";
import type { Sleep } from "../ports/sleep.js";
import {
  createDeterministicLlmProvider,
  offlineModelRates,
} from "../adapters/llm/deterministic-llm-provider.js";
import { createJsonlEventStore } from "../adapters/storage/jsonl-event-store.js";
import { createFileTaskRepository } from "../adapters/storage/file-task-repository.js";
import {
  eventsDirectory,
  projectConfigPath,
} from "../adapters/storage/layout.js";
import type { AgentRunner } from "../ports/agent-runner.js";
import type { AppendLock } from "../ports/append-lock.js";
import type { ChangeProvider } from "../ports/change-provider.js";
import type { ContextEngine } from "../ports/context-engine.js";
import type { EventStore } from "../ports/event-store.js";
import type { LlmProvider } from "../ports/llm-provider.js";
import type { ProcessRunner } from "../ports/process-runner.js";
import type { RepositoryReader } from "../ports/repository-reader.js";
import type { TaskRepository } from "../ports/task-repository.js";
import type { ModelRate } from "../observability/cost.js";
import type { Project } from "../projects/project.js";
import type { Workspace } from "../workspaces/workspace.js";
import { assertWorkspaceBelongsToProject } from "../workspaces/workspace.js";
import {
  type ApprovalLedger,
  createApprovalLedger,
} from "./approval-ledger.js";
import type { ApprovalService } from "./approval-service.js";
import { createApprovalService } from "./approval-service.js";
import {
  DETERMINISTIC_ENGINE_ID,
  createDeterministicContextEngine,
} from "./context-engine.js";
import type { DecisionService } from "./decision-service.js";
import { createDecisionService } from "./decision-service.js";
import type { EventRecorder } from "./event-recorder.js";
import { createEventRecorder } from "./event-recorder.js";
import { type InitialProject, buildInitialProject } from "./init-project.js";
import type { RunTask } from "./run-task.js";
import { createRunTask } from "./run-task.js";
import type { SessionService } from "./session-service.js";
import { createSessionService } from "./session-service.js";
import type { TaskService } from "./task-service.js";
import { createTaskService } from "./task-service.js";
import type { TraceReader } from "./trace.js";
import { createTraceReader } from "./trace.js";

/**
 * The composition root.
 *
 * This is the only module that knows which concrete adapters exist. Above it,
 * everything depends on ports (`EventStore`, `TaskRepository`, `AgentRunner`,
 * `LlmProvider`, `LlmProvider`, `AppendLock`, `Environment`, `HttpTransport`,
 * `Sleep`) and on pure domain modules; below it, adapters know nothing about each
 * other. Swapping JSONL for SQLite, the simulated runner for a real agent, or one
 * vendor for another is a change to this file and nothing else (ADR-022).
 *
 * A `Runtime` is bound to exactly one project and one workspace. That binding is
 * what makes isolation structural rather than a convention: the store and the
 * repository reject a foreign scope, and the run use case rejects a task that
 * belongs to another workspace.
 *
 * Provider selection is configuration-driven (`config.llm`), and the default is the
 * offline deterministic provider, so nothing here requires a vendor account or a
 * network connection to work. Choosing `openai-compatible` constructs a real
 * adapter behind a bounded retry decorator; the credential is read from an
 * environment variable *at call time* and never stored.
 *
 * Nothing here logs, and nothing here reads the environment except through the
 * `Environment` port.
 * See docs/architecture/V2-ARCHITECTURE.md §27 and DECISIONS.md ADR-022.
 */
export interface Runtime {
  readonly projectRoot: string;
  readonly config: ProjectConfig;
  readonly project: Project;
  readonly workspace: Workspace;
  readonly store: EventStore;
  readonly repository: TaskRepository;
  readonly recorder: EventRecorder;
  readonly tasks: TaskService;
  readonly sessions: SessionService;
  readonly decisions: DecisionService;
  readonly approvals: ApprovalService;
  readonly ledger: ApprovalLedger;
  readonly traces: TraceReader;
  readonly runTask: RunTask;
  readonly context: ContextEngine;
  readonly reader: RepositoryReader;
  readonly changeProvider: ChangeProvider;
  /** Context configuration in force, for `ai doctor` and `ai task context`. */
  readonly contextConfig: ContextConfig;
  readonly runner: AgentRunner;
  readonly provider: LlmProvider;
  readonly policy: ReturnType<typeof defaultPolicy>;
  readonly modelRates: readonly ModelRate[];
  readonly providerId: string;
  readonly modelId: string;
  /** Which provider configuration is active, for `ai doctor` to report. */
  readonly llm: LlmConfig;
  /** Append coordination, exposed so `ai doctor` can exercise it for real. */
  readonly lock: AppendLock;
  /** What append coordination is actually in force. */
  readonly lockId: string;
  readonly lockGuarantee: AppendLock["guarantee"];
}

export interface RuntimeOptions {
  readonly projectRoot: string;
  /** Defaults to the first configured workspace. */
  readonly workspaceId?: WorkspaceId;
  readonly clock?: Clock;
  /** Adds one retried model turn, so retry accounting is demonstrable. */
  readonly includeRetry?: boolean;
  /** Overrides the configured provider. Used by tests and by future adapters. */
  readonly provider?: LlmProvider;
  readonly environment?: Environment;
  readonly transport?: HttpTransport;
  readonly sleep?: Sleep;
  readonly lock?: AppendLock;
  /** Overrides context discovery. Tests inject a fixed repository view. */
  readonly reader?: RepositoryReader;
  readonly changeProvider?: ChangeProvider;
  readonly processRunner?: ProcessRunner;
  /** Overrides context selection *and* recording, as the other services allow. */
  readonly contextEngine?: ContextEngine;
}

/**
 * Chooses the provider from configuration.
 *
 * The real provider is always wrapped in the bounded retry decorator, so no code
 * path in the platform can call a vendor without an attempt cap. The decorator is
 * not applied to injected providers, because an injected provider's own retry
 * behaviour is the caller's decision.
 */
function buildProvider(
  llm: LlmConfig,
  deps: {
    readonly clock: Clock;
    readonly environment: Environment;
    readonly transport: HttpTransport;
    readonly sleep: Sleep;
  },
): LlmProvider {
  if (llm.provider === "simulated") {
    return createDeterministicLlmProvider({ clock: deps.clock });
  }
  const provider = createOpenAiCompatibleProvider({
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: llm.baseUrl,
    modelId: llm.modelId,
    credentialEnvVar: llm.credentialEnvVar,
    environment: deps.environment,
    transport: deps.transport,
    clock: deps.clock,
    ...(llm.timeoutMs === undefined ? {} : { timeoutMs: llm.timeoutMs }),
  });
  return createRetryingProvider({
    provider,
    sleep: deps.sleep,
    maxAttempts: llm.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  });
}

/**
 * The selection strategy and version this build implements.
 *
 * Exported so `ai doctor` can report them and so a test can assert that a written
 * configuration agrees with the code that will read it — a version skew between the
 * two would silently make every recorded selection unattributable.
 */
export const CONTEXT_ENGINE_INFO = {
  id: DETERMINISTIC_ENGINE_ID,
  strategy: CONTEXT_STRATEGY,
  selectionVersion: CONTEXT_SELECTION_VERSION,
} as const;

export async function openRuntime(options: RuntimeOptions): Promise<Runtime> {
  const clock = options.clock ?? createSystemClock();
  const sleep = options.sleep ?? createTimerSleep();
  const environment = options.environment ?? createProcessEnvironment();
  const transport = options.transport ?? createFetchTransport();
  const config = await readProjectConfig(options.projectRoot);
  const project = config.project;

  const requested = options.workspaceId;
  const workspace =
    requested === undefined
      ? config.workspaces[0]
      : config.workspaces.find((candidate) => candidate.id === requested);
  if (workspace === undefined) {
    throw new DomainError(
      "NOT_FOUND",
      `workspace "${String(requested)}" is not configured in project "${project.slug}"; ` +
        `configured workspaces: ${config.workspaces.map((candidate) => candidate.id).join(", ")}`,
      { field: "workspaceId" },
    );
  }
  assertWorkspaceBelongsToProject(workspace, project);

  const knownWorkspaceIds = config.workspaces.map((candidate) => candidate.id);
  const lock =
    options.lock ??
    createFileAppendLock({
      directory: eventsDirectory(options.projectRoot),
      clock,
      sleep,
    });
  const store = createJsonlEventStore({
    projectRoot: options.projectRoot,
    projectId: project.id,
    knownWorkspaceIds,
    lock,
  });
  const repository = createFileTaskRepository({
    projectRoot: options.projectRoot,
    projectId: project.id,
    knownWorkspaceIds,
  });

  const recorder = createEventRecorder({
    store,
    projectId: project.id,
    clock,
    eventIds: createUuidIdFactory(),
  });

  const policy = defaultPolicy();
  const provider =
    options.provider ??
    buildProvider(config.llm, { clock, environment, transport, sleep });
  const modelId = provider.models[0];
  const runner = createSimulatedAgentRunner({
    provider,
    modelId,
    clock,
    ...(options.includeRetry === undefined
      ? {}
      : { includeRetry: options.includeRetry }),
  });

  const tasks = createTaskService({
    repository,
    recorder,
    clock,
    taskIds: createUuidIdFactory(),
  });
  const sessions = createSessionService({
    recorder,
    clock,
    sessionIds: createUuidIdFactory(),
  });
  const decisions = createDecisionService({
    recorder,
    clock,
    projectId: project.id,
    decisionIds: createUuidIdFactory(),
  });
  const approvals = createApprovalService({
    recorder,
    clock,
    projectId: project.id,
    requestIds: createUuidIdFactory(),
  });
  const ledger = createApprovalLedger({ store, clock });
  const traces = createTraceReader({
    store,
    repository,
    rates: config.modelRates,
    clock,
  });
  /**
   * Context discovery and selection.
   *
   * The git-backed change provider is only constructed when configuration asks for
   * it, and it degrades to "unavailable" rather than failing, so a workspace that is
   * not a git repository still produces a selection — a smaller, honestly-labelled
   * one. No network, no `git` requirement, no vendor.
   */
  const processRunner =
    options.processRunner ?? createNodeProcessRunner({ clock });
  const reader =
    options.reader ??
    createFileRepositoryReader({ rootPath: workspace.rootPath });
  const changeProvider =
    options.changeProvider ??
    (config.context.useGitChanges
      ? createGitChangeProvider({
          runner: processRunner,
          workspaceRoot: workspace.rootPath,
        })
      : createDisabledChangeProvider());
  const context =
    options.contextEngine ??
    createDeterministicContextEngine({
      reader,
      changes: changeProvider,
      recorder,
      clock,
      config: config.context,
      project,
      workspace,
      selectionIds: createUuidIdFactory(),
    });
  const runTask = createRunTask({
    tasks,
    sessions,
    decisions,
    approvals,
    ledger,
    runner,
    policy,
    workspace,
    rates: config.modelRates,
    clock,
    providerId: provider.id,
    modelId,
    context,
    contextConfig: config.context,
  });

  return {
    projectRoot: options.projectRoot,
    config,
    project,
    workspace,
    store,
    repository,
    recorder,
    tasks,
    sessions,
    decisions,
    approvals,
    ledger,
    traces,
    runTask,
    context,
    reader,
    changeProvider,
    contextConfig: config.context,
    runner,
    provider,
    policy,
    modelRates: config.modelRates,
    providerId: provider.id,
    modelId,
    llm: config.llm,
    lock,
    lockId: lock.id,
    lockGuarantee: lock.guarantee,
  };
}

export interface InitializeProjectOptions {
  /** Absolute path of the project root. */
  readonly projectRoot: string;
  readonly name: string;
  readonly slug: string;
  /** Overwrite an existing configuration. Never touches the event log. */
  readonly force?: boolean;
  readonly clock?: Clock;
  /**
   * Provider configuration to write. Defaults to the offline provider, which needs
   * no credential: a project must be usable before it has a vendor account.
   */
  readonly llm?: LlmConfig;
  /**
   * Context configuration to write. Defaults to the documented budgets, so an
   * `ai init` produces a project that can select context immediately.
   */
  readonly context?: ContextConfig;
}

export interface InitializeProjectResult {
  readonly config: ProjectConfig;
  readonly configPath: string;
  readonly initial: InitialProject;
}

/**
 * `ai init`: provision the project configuration and the runtime layout.
 *
 * Idempotence is deliberate rather than convenient: without `--force` an existing
 * configuration is a `CONFLICT`, because silently rewriting a project's identity
 * would orphan every task already recorded under it. `--force` rewrites
 * configuration only — the append-only event log is never touched.
 */
export async function initializeProject(
  options: InitializeProjectOptions,
): Promise<InitializeProjectResult> {
  const clock = options.clock ?? createSystemClock();
  const configPath = projectConfigPath(options.projectRoot);

  let exists = true;
  try {
    await access(configPath);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    exists = false;
  }
  if (exists && options.force !== true) {
    throw new DomainError(
      "CONFLICT",
      `${configPath} already exists; pass --force to rewrite the project configuration`,
      { field: "config", path: configPath },
    );
  }

  const initial = buildInitialProject(
    {
      name: options.name,
      slug: options.slug,
      rootPath: options.projectRoot,
    },
    {
      clock,
      newProjectId: () => createUuidIdFactory().next(),
      newWorkspaceId: () => createUuidIdFactory().next(),
      modelRates: offlineModelRates(),
    },
  );

  await mkdir(options.projectRoot, { recursive: true });
  await ensureRuntimeLayout(options.projectRoot);
  const config: ProjectConfig = {
    schemaVersion: 1,
    project: initial.project,
    workspaces: initial.workspaces,
    modelRates: initial.modelRates,
    llm: options.llm ?? DEFAULT_LLM_CONFIG,
    context: options.context ?? DEFAULT_CONTEXT_CONFIG,
  };
  await writeProjectConfig(options.projectRoot, config);
  return { config, configPath, initial };
}
