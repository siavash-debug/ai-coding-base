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
  DEFAULT_DECISION_CONFIG,
  DEFAULT_FRONTIER_CONFIG,
  DEFAULT_LLM_CONFIG,
  type ContextConfig,
  type DecisionConfig,
  type FrontierConfig,
  type LlmConfig,
  type ProjectConfig,
  ensureRuntimeLayout,
  generativeModels,
  isMissingFile,
  readProjectConfig,
  writeProjectConfig,
} from "../adapters/config/project-config.js";
import { createJevHttpProvider } from "../adapters/decision/jev-http-provider.js";
import { createTypeSafeProvider } from "../adapters/decision/typesafe-provider.js";
import { createLlmFrontier } from "../adapters/frontier/llm-frontier.js";
import { createModelRegistry, type ModelRegistry } from "../models/registry.js";
import {
  createOrchestrator,
  type Orchestrator,
} from "../orchestration/orchestrator.js";
import type { FrontierExecutor } from "../ports/frontier.js";
import {
  type DecisionEngine,
  type DecisionEngineInfo,
  createDecisionEngine,
} from "../decisions/engine.js";
import type { DecisionProvider } from "../decisions/provider.js";
import {
  type DecisionCoordinatorFactory,
  createDecisionCoordinatorFactory,
} from "./decision-coordinator.js";
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
import { createGuardedNetwork } from "../adapters/sandbox/guarded-network.js";
import { createFileRepositoryReader } from "../adapters/repository/file-repository-reader.js";
import { createFileAppendLock } from "../adapters/storage/file-append-lock.js";
import { createTimerSleep } from "../adapters/time/timer-sleep.js";
import { createProcessEnvironment } from "../ports/environment.js";
import type { Environment } from "../ports/environment.js";
import {
  type AccessPolicy,
  initialAccessPolicy,
} from "../policy/access-policy.js";
import type { SandboxBoundary } from "../ports/operation.js";
import { createLocalSandbox } from "../adapters/sandbox/local-sandbox.js";
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
import {
  type CredentialRequirement,
  providerCredentialRequirements,
} from "./credential-preflight.js";
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
import {
  OPERATION_GATEWAY_ACTOR,
  type OperationGatewayFactory,
  capabilityEnvelope,
  createOperationGatewayFactory,
} from "./operation-gateway.js";
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
  /**
   * The decision layer for this workspace, and what it is.
   *
   * `provider` is absent when no decision engine is configured, which is the
   * default: bounded questions are then answered by deterministic code and recorded
   * as such, with no network call (ADR-004, ADR-052).
   */
  readonly decision: DecisionConfig;
  readonly decisionProvider?: DecisionProvider;
  readonly decisionEngine: DecisionEngineInfo;
  readonly decisionLayer: DecisionCoordinatorFactory;
  /**
   * The model catalog this workspace may route to, and the routing policy.
   *
   * `registry` is knowledge (what models can do); `frontier` executes a chosen step;
   * `orchestrator` is the use case that joins them to the decision layer. Routing is
   * off unless the project enabled it, so a runtime without frontier configuration
   * behaves exactly as it did before Phase H.
   */
  readonly registry: ModelRegistry;
  readonly frontier: FrontierExecutor;
  readonly frontierConfig: FrontierConfig;
  readonly frontierProviders: readonly string[];
  readonly orchestrator: Orchestrator;
  /**
   * The credentials this runtime would need to reach the providers it wired.
   *
   * Derived once, here, from the same configuration the adapters were built from, so
   * a run can refuse before it starts rather than discovering an unset variable at
   * the first call (ADR-033). `Environment` is exposed alongside it because checking
   * presence must go through the same single reader the adapters use.
   */
  readonly credentialRequirements: readonly CredentialRequirement[];
  readonly environment: Environment;
  /**
   * The enforcement boundary for this workspace, and the capabilities granted.
   *
   * Exposed for `ai doctor`, `ai policy` and the security tests: the runtime is
   * the only place a sandbox is constructed, and nothing above it ever receives
   * the underlying `fs`, `child_process`, `fetch` or `process.env`.
   */
  readonly accessPolicy: AccessPolicy;
  readonly sandbox: SandboxBoundary;
  readonly operations: OperationGatewayFactory;
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
  /**
   * Overrides the configured access policy.
   *
   * Used by tests to construct a project whose boundary allows exactly one thing,
   * so "this capability is denied" can be proven without editing a configuration
   * file. It is never set by the CLI: the CLI reads policy from the project.
   */
  readonly accessPolicy?: AccessPolicy;
  /** Overrides the sandbox boundary, for boundary-level tests. */
  readonly sandbox?: SandboxBoundary;
  /**
   * Overrides the configured decision provider.
   *
   * Used by tests to drive the decision path deterministically, exactly as
   * `provider` overrides the LLM provider. An injected provider makes the decision
   * layer configured even when configuration says `disabled`, because injection *is*
   * configuration for a test.
   */
  readonly decisionProvider?: DecisionProvider;
  /**
   * Overrides the provider adapters the frontier executes through.
   *
   * Used by tests to drive multi-model execution without a transport, exactly as
   * `provider` overrides the single configured LLM provider. The registry, the plan
   * build and every decision still run for real.
   */
  readonly frontierProviders?: ReadonlyMap<string, LlmProvider>;
  /**
   * Overrides the frontier executor itself.
   *
   * Used by tests to script multi-model execution without a transport. The registry,
   * the plan build and every decision still run for real, so what is being tested is
   * the orchestration and not the fake.
   */
  readonly frontier?: FrontierExecutor;
}

/**
 * Chooses the decision provider from configuration.
 *
 * Absent means "no decision engine is installed", which the engine reports honestly
 * and which is a fully supported state: every bounded question is then answered by
 * the deterministic gate or the deterministic fallback, and recorded. There is no
 * neutral provider that invents answers, so none is constructed (ADR-052).
 */
function buildDecisionProvider(
  decision: DecisionConfig,
  deps: {
    readonly clock: Clock;
    readonly environment: Environment;
    readonly transport: HttpTransport;
  },
): DecisionProvider | undefined {
  if (decision.provider === "disabled") {
    return undefined;
  }
  if (decision.provider === "typesafe") {
    // TypeSafe is the JEV implementation, reached through the same guarded transport
    // as every other provider: configuring it does not make its host reachable.
    return createTypeSafeProvider({
      credentialEnvVar: decision.credentialEnvVar,
      environment: deps.environment,
      transport: deps.transport,
      clock: deps.clock,
      ...(decision.baseUrl === undefined ? {} : { baseUrl: decision.baseUrl }),
      ...(decision.defaultModel === undefined
        ? {}
        : { defaultModel: decision.defaultModel }),
      ...(decision.timeoutMs === undefined
        ? {}
        : { timeoutMs: decision.timeoutMs }),
    });
  }
  return createJevHttpProvider({
    baseUrl: decision.baseUrl,
    credentialEnvVar: decision.credentialEnvVar,
    environment: deps.environment,
    transport: deps.transport,
    clock: deps.clock,
    ...(decision.modelId === undefined ? {} : { modelId: decision.modelId }),
    ...(decision.timeoutMs === undefined
      ? {}
      : { timeoutMs: decision.timeoutMs }),
  });
}

/**
 * Builds the provider adapters the frontier may execute through.
 *
 * One adapter per configured provider, each bound to the models the registry declares
 * for it and to the *guarded* transport — so a frontier step cannot become the one
 * call path that skips provider egress policy. A provider with no registered model is
 * not constructed at all: there would be nothing it could serve.
 */
function buildFrontierProviders(
  frontier: FrontierConfig,
  deps: {
    readonly clock: Clock;
    readonly environment: Environment;
    readonly transport: HttpTransport;
    readonly sleep: Sleep;
  },
): ReadonlyMap<string, LlmProvider> {
  const providers = new Map<string, LlmProvider>();
  for (const provider of frontier.providers) {
    // Only generative models are ever handed to a generative adapter. A registered
    // model with a non-generative role stays knowledge in the registry; it cannot
    // become a model id this adapter claims to serve, so no plan can reach it.
    const models = generativeModels(frontier)
      .filter((model) => model.providerId === provider.id)
      .map((model) => model.modelId);
    const [primary, ...additional] = models;
    if (primary === undefined) {
      continue;
    }
    const adapter = createOpenAiCompatibleProvider({
      id: provider.id,
      baseUrl: provider.baseUrl,
      modelId: primary,
      additionalModels: additional,
      credentialEnvVar: provider.credentialEnvVar,
      environment: deps.environment,
      transport: deps.transport,
      clock: deps.clock,
      ...(provider.timeoutMs === undefined
        ? {}
        : { timeoutMs: provider.timeoutMs }),
    });
    providers.set(
      provider.id,
      createRetryingProvider({
        provider: adapter,
        sleep: deps.sleep,
        maxAttempts: provider.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      }),
    );
  }
  return providers;
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
  /**
   * The access policy this runtime enforces, resolved before anything that can
   * reach outside the process.
   *
   * Two boundaries read it: the sandbox that performs operations, and the guard on
   * the platform's *own* provider egress below. Resolving it once is what keeps
   * "which hosts may this project reach?" a single answer (ADR-050).
   */
  const accessPolicy = options.accessPolicy ?? config.policy;
  /**
   * What every real provider adapter is handed instead of the raw transport.
   *
   * Configuring a provider does not make its host reachable: the host must also be
   * listed in `policy.network.providerHosts`, or the adapter is constructed and then
   * refused at the transport before a socket exists. This is the same guard the local
   * sandbox builds over the same lists, applied here so that no provider — LLM or
   * decision — can become the one path that skips it.
   */
  const providerEgress = createGuardedNetwork({
    transport,
    operationEnabled: accessPolicy.network.enabled,
    operationHosts: accessPolicy.network.allowedHosts,
    providerHosts: accessPolicy.network.providerHosts,
  }).providerTransport;
  const provider =
    options.provider ??
    buildProvider(config.llm, {
      clock,
      environment,
      transport: providerEgress,
      sleep,
    });
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
  /**
   * The enforcement boundary, constructed here and nowhere else.
   *
   * The sandbox is bound to this one workspace, so the fence every reference
   * resolves against is a property of the runtime rather than an argument (ADR-048).
   * The envelope is derived from the access policy: a runtime never negotiates its
   * own capabilities, and an empty envelope means the runtime can plan and record
   * but not reach anything.
   */
  const sandbox =
    options.sandbox ??
    createLocalSandbox({
      scope: {
        projectId: project.id,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        projectRoot: options.projectRoot,
      },
      policy: accessPolicy,
      clock,
      environment,
      transport,
    });
  /**
   * The decision layer.
   *
   * Built after the recorder — decisions are recorded as events like everything else
   * — and before `runTask`, which asks it the bounded questions along the attempt
   * path. The engine holds no scope: scope is bound per attempt in the coordinator,
   * so a decision cannot be attributed to a task or workspace it does not belong to.
   */
  const decisionProvider =
    options.decisionProvider ??
    buildDecisionProvider(config.decision, {
      clock,
      environment,
      transport: providerEgress,
    });
  const decisionEngine: DecisionEngine = createDecisionEngine({
    clock,
    ...(decisionProvider === undefined ? {} : { provider: decisionProvider }),
  });
  const decisionLayer = createDecisionCoordinatorFactory({
    engine: decisionEngine,
    decisions,
    recorder,
    store,
    clock,
    config: config.decision,
    rates: config.modelRates,
    projectId: project.id,
  });

  /**
   * Model registry, frontier executor and orchestration use case.
   *
   * Constructed from this project's own configuration, so one project's models are
   * never visible to another. The frontier receives provider adapters that are already
   * bound to the guarded transport: no orchestration path can reach a vendor host
   * that policy has not allowed (ADR-050, ADR-056).
   */
  const registry = createModelRegistry({ models: config.frontier.models });
  const frontierProviders = buildFrontierProviders(config.frontier, {
    clock,
    environment,
    transport: providerEgress,
    sleep,
  });
  const frontier =
    options.frontier ??
    createLlmFrontier({
      providers: options.frontierProviders ?? frontierProviders,
      registry,
      clock,
    });
  const orchestrator = createOrchestrator({
    registry,
    rates: config.modelRates,
    frontier,
    sessions,
    tasks,
    recorder,
    store,
    decisions: decisionLayer,
    clock,
    projectId: project.id,
    workspace,
    config: {
      enabled: config.frontier.enabled,
      mode: config.frontier.routing.mode,
      allowDecomposition: config.frontier.routing.allowDecomposition,
      allowParallel: config.frontier.routing.allowParallel,
      maxModelCalls: config.frontier.routing.maxModelCalls,
      maxRetriesPerStep: config.frontier.routing.maxRetriesPerStep,
    },
  });

  /**
   * What this runtime would need to reach the providers it just wired.
   *
   * Computed from the installed decision provider, the configured LLM provider and
   * the frontier adapters that were actually built — never from a list kept in step
   * by hand. `ai task run` and `ai task orchestrate` check it before starting work;
   * `ai doctor` reports the same facts in more detail (ADR-033).
   */
  const credentialRequirements = providerCredentialRequirements({
    llm: config.llm,
    decision: config.decision,
    ...(decisionProvider === undefined
      ? {}
      : { decisionProviderId: decisionProvider.id }),
    frontier: config.frontier,
    frontierProviderIds: [
      ...(options.frontierProviders ?? frontierProviders).keys(),
    ],
  });

  const operations = createOperationGatewayFactory({
    policy: accessPolicy,
    envelope: capabilityEnvelope(accessPolicy),
    boundary: sandbox,
    ledger,
    approvals,
    recorder,
    clock,
    ids: createUuidIdFactory(),
    actor: OPERATION_GATEWAY_ACTOR,
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
    operations,
    recorder,
    decisionLayer,
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
    accessPolicy,
    sandbox,
    operations,
    decision: config.decision,
    ...(decisionProvider === undefined ? {} : { decisionProvider }),
    decisionEngine: decisionEngine.info,
    decisionLayer,
    registry,
    frontier,
    frontierConfig: config.frontier,
    frontierProviders: [
      ...(options.frontierProviders ?? frontierProviders).keys(),
    ].sort(),
    orchestrator,
    credentialRequirements,
    environment,
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
  /**
   * Decision-layer configuration to write. Defaults to `disabled`, so a freshly
   * initialised project needs no decision service and makes no decision call.
   */
  readonly decision?: DecisionConfig;
  /**
   * Frontier configuration to write. Defaults to the documented model catalog with
   * routing disabled, so a freshly initialised project knows which models exist
   * without being able to call any of them.
   */
  readonly frontier?: FrontierConfig;
  /**
   * Access policy to write. Defaults to read-only within the workspace.
   *
   * Writes, process execution, network access and environment access are not part
   * of the default: each is a deliberate operator decision made visible in
   * `.ai/project.json` rather than granted implicitly by initialisation.
   */
  readonly policy?: AccessPolicy;
  /**
   * Pricing table to write. Defaults to the offline rates, so a project is usable
   * before anyone has decided what a model costs — and an unknown model stays
   * *unpriced* rather than becoming free.
   */
  readonly modelRates?: readonly ModelRate[];
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
      modelRates: options.modelRates ?? offlineModelRates(),
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
    policy: options.policy ?? initialAccessPolicy(),
    decision: options.decision ?? DEFAULT_DECISION_CONFIG,
    frontier: options.frontier ?? DEFAULT_FRONTIER_CONFIG,
  };
  await writeProjectConfig(options.projectRoot, config);
  return { config, configPath, initial };
}
