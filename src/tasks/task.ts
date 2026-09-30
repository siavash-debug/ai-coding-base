import { type Clock, toIsoString } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import type { TaskId } from "../core/ids.js";
import {
  assertIsoTimestamp,
  assertNonEmptyString,
  assertOneOf,
  assertStringArray,
} from "../core/validation.js";
import { RISK_LEVELS, type RiskLevel } from "../decisions/risk.js";
import type { Budget } from "../observability/budget.js";
import { validateBudget } from "../observability/budget.js";
import type { Project } from "../projects/project.js";
import { assertWorkspaceBelongsToProject } from "../workspaces/workspace.js";
import type { Workspace } from "../workspaces/workspace.js";
import {
  type TaskStatus,
  TASK_STATUSES,
  isTerminalStatus,
  transitionStatus,
} from "./lifecycle.js";

/**
 * Task: the first-class unit of engineering work and the anchor of traceability.
 *
 * The task holds identity and contract only. Usage, cost, calls, decisions and
 * tests are attached by `taskId` through the event log.
 * See docs/architecture/V2-ARCHITECTURE.md §6 and DECISIONS.md ADR-005.
 */
export const ACCEPTANCE_CRITERION_STATUSES = [
  "pending",
  "met",
  "not-met",
  "waived",
] as const;

export type AcceptanceCriterionStatus =
  (typeof ACCEPTANCE_CRITERION_STATUSES)[number];

/**
 * The deterministic verification a criterion is assessed by, when one exists.
 *
 * `suite` names a verification the runtime records — the stable suite name on a
 * `TestCompleted` event. Binding a criterion to a suite is an *explicit claim by the
 * task author* that this verification decides this criterion, and it is the only way
 * a criterion ever becomes `met` or `not-met` without a human asserting it. Nothing
 * infers a binding, and a criterion without one is never machine-assessed.
 *
 * `check`, when present, narrows the claim to one *named* check inside that suite —
 * the operator-declared id the runtime reports on an individual `TestCompleted`
 * event. It is what makes the evidence criterion-specific: a criterion bound to
 * `check` is assessed from that check's own outcome and is *not* invalidated by an
 * unrelated check failing in the same suite. Absent, the criterion keeps the suite's
 * own whole-suite verdict, which is the behaviour that predates named checks.
 *
 * The join is deliberately narrow: an execution event is only ever acceptance
 * evidence for a criterion when that criterion named the suite — and, when it named
 * one, the check — the event belongs to.
 */
export interface AcceptanceCriterionEvidenceBinding {
  readonly suite: string;
  readonly check?: string;
}

/**
 * The statuses an explicit human verdict can establish.
 *
 * `pending` is deliberately absent. A verdict is an assertion about a criterion, and
 * "not established" is the state a task starts in rather than something a person
 * asserts; the platform therefore has no operation that returns a criterion to
 * `pending`. What a verdict *can* establish is that the criterion is met, that it is
 * not met, or that it is deliberately not required.
 */
export const ACCEPTANCE_VERDICT_STATUSES = [
  "met",
  "not-met",
  "waived",
] as const;

export type AcceptanceVerdictStatus =
  (typeof ACCEPTANCE_VERDICT_STATUSES)[number];

export interface TaskAcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly status: AcceptanceCriterionStatus;
  /** Present only when the criterion is machine-assessable from verification. */
  readonly verifiedBy?: AcceptanceCriterionEvidenceBinding;
  /**
   * References — suite name and check counts — that produced an automatic status.
   * Never content, and absent until an assessment has run.
   */
  readonly evidence?: readonly string[];
  /**
   * Who took responsibility for this criterion's status, when a human set it.
   *
   * Mutually exclusive with `evidence`, because the two are different claims about who
   * decided: `evidence` says a verification the criterion named decided it, `verdictBy`
   * says a named person did. A reader who has only the record can therefore tell
   * "verified" from "accepted" from "waived" without prose, and a criterion no
   * verification can decide is not left looking machine-assessable (ADR-060, ADR-062).
   */
  readonly verdictBy?: string;
}

/** One criterion as the caller declared it: either bare text or an explicit binding. */
export interface AcceptanceCriterionInput {
  readonly statement: string;
  readonly verifiedBy?: AcceptanceCriterionEvidenceBinding;
}

/**
 * One verification result's recorded outcome, as the runtime observed it.
 *
 * This is the whole of the evidence vocabulary a criterion can be assessed from:
 * which suite ran, which named check (when one), and how many of its checks passed
 * or failed. No result is ever attributed to a criterion the task did not bind to
 * it, and a step without `check` is only ever whole-suite evidence.
 */
export interface VerificationSuiteEvidence {
  readonly suite: string;
  /** Present only for a named check; absent for a whole-suite result. */
  readonly check?: string;
  readonly passed: number;
  readonly failed: number;
}

/** One automatic assessment, with the exact evidence that produced it. */
export interface AcceptanceAssessment {
  readonly criterionId: string;
  readonly status: "met" | "not-met";
  readonly suite: string;
  /** Present when the criterion was assessed from a specific named check. */
  readonly check?: string;
  readonly passed: number;
  readonly failed: number;
}

/** Maps to docs/TASK_CONTRACT.md §9.1 verification levels. */
export const VERIFICATION_LEVELS = [1, 2, 3, 4, 5] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export interface VerificationStep {
  readonly level: VerificationLevel;
  readonly command: string;
  readonly required: boolean;
}

export interface Task {
  readonly id: TaskId;
  readonly projectId: Project["id"];
  readonly workspaceId: Workspace["id"];
  readonly title: string;
  readonly description: string;
  readonly context: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly TaskAcceptanceCriterion[];
  readonly riskLevel: RiskLevel;
  readonly budget: Budget;
  readonly status: TaskStatus;
  readonly verificationStrategy: readonly VerificationStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly description: string;
  readonly context?: readonly string[];
  readonly constraints?: readonly string[];
  /**
   * Acceptance criteria. A bare string is a criterion no machine assesses; the
   * structured form additionally declares the verification suite that assesses it.
   */
  readonly acceptanceCriteria?: readonly (string | AcceptanceCriterionInput)[];
  readonly riskLevel?: RiskLevel;
  readonly budget?: Budget;
  readonly verificationStrategy?: readonly VerificationStep[];
}

export interface AcceptanceSummary {
  readonly total: number;
  readonly met: number;
  readonly notMet: number;
  readonly waived: number;
  readonly pending: number;
  /** A task with no acceptance criteria is NOT considered verified. */
  readonly allMet: boolean;
}

/**
 * Validates a declared evidence binding, or returns `undefined` when there is none.
 *
 * A binding must name a suite: an empty or non-string suite would create a criterion
 * that can never be assessed while looking machine-assessable, which is worse than an
 * explicit `pending`.
 */
export function validateAcceptanceEvidenceBinding(
  value: unknown,
  field: string,
): AcceptanceCriterionEvidenceBinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an object`, {
      field,
    });
  }
  const record = value as Record<string, unknown>;
  const suite = assertNonEmptyString(record["suite"], `${field}.suite`);
  const check =
    record["check"] === undefined
      ? undefined
      : assertNonEmptyString(record["check"], `${field}.check`);
  return { suite, ...(check === undefined ? {} : { check }) };
}

function toAcceptanceCriteria(
  inputs: readonly (string | AcceptanceCriterionInput)[],
): readonly TaskAcceptanceCriterion[] {
  return inputs.map((input, index) => {
    const id = `AC-${index + 1}`;
    if (typeof input === "string") {
      return {
        id,
        statement: assertNonEmptyString(input, `acceptanceCriteria[${index}]`),
        status: "pending" as const,
      };
    }
    if (typeof input !== "object" || input === null) {
      throw new DomainError(
        "VALIDATION",
        `acceptanceCriteria[${index}] must be a string or an object with a statement`,
        { field: `acceptanceCriteria[${index}]` },
      );
    }
    const statement = assertNonEmptyString(
      input.statement,
      `acceptanceCriteria[${index}].statement`,
    );
    const verifiedBy = validateAcceptanceEvidenceBinding(
      input.verifiedBy,
      `acceptanceCriteria[${index}].verifiedBy`,
    );
    return {
      id,
      statement,
      status: "pending" as const,
      ...(verifiedBy === undefined ? {} : { verifiedBy }),
    };
  });
}

function validateVerificationStep(
  step: VerificationStep,
  index: number,
): VerificationStep {
  const field = `verificationStrategy[${index}]`;
  const level = step.level;
  if (!VERIFICATION_LEVELS.includes(level)) {
    throw new DomainError(
      "VALIDATION",
      `${field}.level must be one of: ${VERIFICATION_LEVELS.join(", ")}`,
      { field: `${field}.level` },
    );
  }
  const command = assertNonEmptyString(step.command, `${field}.command`);
  if (typeof step.required !== "boolean") {
    throw new DomainError("VALIDATION", `${field}.required must be a boolean`, {
      field: `${field}.required`,
    });
  }
  return { level, command, required: step.required };
}

export function createTask(
  input: CreateTaskInput,
  options: {
    readonly id: TaskId;
    readonly project: Project;
    readonly workspace: Workspace;
    readonly clock: Clock;
  },
): Task {
  assertWorkspaceBelongsToProject(options.workspace, options.project);
  if (options.project.status !== "active") {
    throw new DomainError(
      "INVARIANT",
      "a task cannot be created in an archived project",
      { field: "project.status" },
    );
  }
  if (options.workspace.status === "archived") {
    throw new DomainError(
      "INVARIANT",
      "a task cannot be created in an archived workspace",
      { field: "workspace.status" },
    );
  }

  const title = assertNonEmptyString(input.title, "title");
  const description = assertNonEmptyString(input.description, "description");
  const context = assertStringArray(input.context ?? [], "context");
  const constraints = assertStringArray(input.constraints ?? [], "constraints");
  const acceptanceCriteria = toAcceptanceCriteria(
    assertAcceptanceCriteriaInput(input.acceptanceCriteria ?? []),
  );
  // `medium` is the safe default: it requires verification and cannot lower the
  // effective risk of any operation (see decisions/risk.ts).
  const riskLevel =
    input.riskLevel === undefined
      ? "medium"
      : assertOneOf(input.riskLevel, RISK_LEVELS, "riskLevel");
  const budget = input.budget ?? {};
  validateBudget(budget);
  const verificationStrategy = (input.verificationStrategy ?? []).map(
    validateVerificationStep,
  );
  const now = toIsoString(options.clock.now());

  return {
    id: options.id,
    projectId: options.project.id,
    workspaceId: options.workspace.id,
    title,
    description,
    context,
    constraints,
    acceptanceCriteria,
    riskLevel,
    budget,
    status: "created",
    verificationStrategy,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Only legal transitions are applied; illegal ones throw a typed error.
 * `completedAt` is set if and only if the task becomes `completed`.
 */
export function transitionTask(
  task: Task,
  next: TaskStatus,
  clock: Clock,
): Task {
  const status = transitionStatus(task.status, next);
  const now = toIsoString(clock.now());
  const transitioned: Task = {
    ...task,
    status,
    updatedAt: now,
    ...(status === "completed" ? { completedAt: now } : {}),
  };
  return transitioned;
}

/**
 * Sets the status of one acceptance criterion.
 *
 * Together with `assessAcceptanceCriteria` this is one of the platform's two ways a
 * criterion stops being `pending`, and the two are deliberately separate: assessment is
 * the verification contract deciding, and this is a decision being recorded. Both write
 * the same field, so both must leave provenance behind.
 *
 * `verdictBy` is the identity of the person taking responsibility, and passing it makes
 * the call an explicit human verdict: the machine's `evidence` references are dropped
 * with the machine's status, because a `met` criterion whose provenance still said a
 * check failed would be a record that argues with itself. The author's `verifiedBy`
 * *binding* stays: it says which evidence was supposed to decide the criterion, which is
 * still true after a human overrules it, and it is what makes the overrule visible.
 *
 * A terminal task refuses any change, so "the criteria of a closed task cannot move"
 * holds by construction rather than by convention.
 */
export function markAcceptanceCriterion(
  task: Task,
  criterionId: string,
  status: AcceptanceCriterionStatus,
  clock: Clock,
  verdictBy?: string,
): Task {
  if (isTerminalStatus(task.status)) {
    throw new DomainError(
      "INVARIANT",
      `acceptance criteria of a terminal task (${task.status}) cannot change`,
      { field: "task.status" },
    );
  }
  const index = task.acceptanceCriteria.findIndex(
    (criterion) => criterion.id === criterionId,
  );
  if (index === -1) {
    throw new DomainError(
      "NOT_FOUND",
      `unknown acceptance criterion "${criterionId}"`,
      { field: "criterionId" },
    );
  }
  const criterionStatus = assertOneOf(
    status,
    ACCEPTANCE_CRITERION_STATUSES,
    "status",
  );
  const acceptanceCriteria = task.acceptanceCriteria.map((criterion, at) => {
    if (at !== index) {
      return criterion;
    }
    if (verdictBy === undefined) {
      return { ...criterion, status: criterionStatus };
    }
    return {
      id: criterion.id,
      statement: criterion.statement,
      status: criterionStatus,
      ...(criterion.verifiedBy === undefined
        ? {}
        : { verifiedBy: criterion.verifiedBy }),
      verdictBy: assertNonEmptyString(verdictBy, "verdictBy"),
    };
  });
  return {
    ...task,
    acceptanceCriteria,
    updatedAt: toIsoString(clock.now()),
  };
}

export function acceptanceSummary(task: Task): AcceptanceSummary {
  let met = 0;
  let notMet = 0;
  let waived = 0;
  let pending = 0;
  for (const criterion of task.acceptanceCriteria) {
    if (criterion.status === "met") {
      met += 1;
    } else if (criterion.status === "not-met") {
      notMet += 1;
    } else if (criterion.status === "waived") {
      waived += 1;
    } else {
      pending += 1;
    }
  }
  const total = task.acceptanceCriteria.length;
  return {
    total,
    met,
    notMet,
    waived,
    pending,
    allMet: total > 0 && met + waived === total,
  };
}

/**
 * Criterion-level acceptance evidence, or nothing at all.
 *
 * Returns the number of acceptance criteria established as satisfied — `met` plus
 * `waived` — **only when at least one criterion has actually been assessed**. As long
 * as every criterion is still `pending`, nothing has been measured and the answer is
 * `undefined`: the completion contract is explicit that "not measured" and "zero met"
 * are different facts, and a runtime that reported `0` here would be inventing a
 * measurement it never took (`decisions/domains.ts`, `CompletionDecisionInput`).
 *
 * The only producer of a non-`pending` status is `markAcceptanceCriterion`, which is
 * deterministic and explicit: a human or a named step asserts a criterion, and the
 * assertion is on the record. Nothing here infers satisfaction from a passing test —
 * a verification command proves that a *check* ran, never that a criterion was met.
 */
export function measuredAcceptanceCriteriaMet(task: Task): number | undefined {
  const summary = acceptanceSummary(task);
  if (summary.total === 0 || summary.pending === summary.total) {
    return undefined;
  }
  return summary.met + summary.waived;
}

/**
 * Structural check for the criteria input, which is a list of strings or bindings.
 *
 * Kept here rather than in `core/validation` because the accepted shape is this
 * domain's own contract, not a generic primitive.
 */
function assertAcceptanceCriteriaInput(
  value: unknown,
  field = "acceptanceCriteria",
): readonly (string | AcceptanceCriterionInput)[] {
  if (!Array.isArray(value)) {
    throw new DomainError("VALIDATION", `${field} must be an array`, { field });
  }
  return value as readonly (string | AcceptanceCriterionInput)[];
}

/**
 * Assesses every `pending`, explicitly bound criterion from recorded verification.
 *
 * The rules are the whole evidence policy, and each is deterministic:
 *
 * - **Only bound criteria are candidates.** A criterion with no `verifiedBy` is left
 *   exactly as it is: it stays `pending` until a human or an explicit step asserts it.
 * - **Only `pending` criteria are assessed.** A status a human already set (`met`,
 *   `not-met` or `waived`) is never overwritten by a later run's evidence.
 * - **A failure outranks a pass.** When the bound evidence reported any failing check
 *   the criterion is `not-met`; otherwise, if it reported at least one check, it is
 *   `met`.
 * - **A named check is assessed alone.** When the binding names a `check`, only that
 *   check's own outcome is used: an unrelated failing check in the same suite neither
 *   satisfies nor invalidates the criterion.
 * - **No result is no evidence.** A bound suite that never ran, a named check that
 *   never ran, or a result with zero checks, leaves the criterion `pending`.
 *
 * Every automatic status carries the suite name, the check id (when the binding named
 * one) and the counts that produced it, so the assessment is reproducible from the
 * log: a reader joins the criterion's `verifiedBy` and `evidence` to the
 * `TestCompleted` event for that suite or check.
 */
export function assessAcceptanceCriteria(
  task: Task,
  evidence: readonly VerificationSuiteEvidence[],
  clock: Clock,
): {
  readonly task: Task;
  readonly assessed: readonly AcceptanceAssessment[];
} {
  // Two accumulators, both deterministic. The suite one is the whole-suite verdict
  // (the pre-existing coarse evidence); the check one holds each named check's own
  // outcome. A check key is `suite` + a separator + `check`, a join of two already
  // stable strings rather than a new identity invented here.
  const bySuite = new Map<string, { passed: number; failed: number }>();
  const byCheck = new Map<string, VerificationSuiteEvidence>();
  const checkKey = (suite: string, check: string): string =>
    `${suite}\u0000${check}`;
  for (const item of evidence) {
    const existing = bySuite.get(item.suite);
    bySuite.set(item.suite, {
      passed: (existing?.passed ?? 0) + item.passed,
      failed: (existing?.failed ?? 0) + item.failed,
    });
    if (item.check !== undefined) {
      const key = checkKey(item.suite, item.check);
      const prior = byCheck.get(key);
      byCheck.set(key, {
        suite: item.suite,
        check: item.check,
        passed: (prior?.passed ?? 0) + item.passed,
        failed: (prior?.failed ?? 0) + item.failed,
      });
    }
  }

  const assessed: AcceptanceAssessment[] = [];
  const acceptanceCriteria = task.acceptanceCriteria.map((criterion) => {
    const binding = criterion.verifiedBy;
    if (criterion.status !== "pending" || binding === undefined) {
      return criterion;
    }

    // A criterion with a named-check binding is assessed from *that check alone*: a
    // failure elsewhere in the suite cannot invalidate it, and a check that never ran
    // leaves it `pending` rather than borrowing the suite's verdict.
    if (binding.check !== undefined) {
      const found = byCheck.get(checkKey(binding.suite, binding.check));
      if (found === undefined || found.passed + found.failed === 0) {
        return criterion;
      }
      const status = found.failed > 0 ? ("not-met" as const) : ("met" as const);
      const refs = [
        `suite:${binding.suite}`,
        `check:${binding.check}`,
        `result:${status === "met" ? "passed" : "failed"}`,
        `passed:${found.passed}`,
        `failed:${found.failed}`,
      ];
      assessed.push({
        criterionId: criterion.id,
        status,
        suite: binding.suite,
        check: binding.check,
        passed: found.passed,
        failed: found.failed,
      });
      return { ...criterion, status, evidence: refs };
    }

    // Suite-only binding: the whole-suite verdict, exactly as before named checks.
    const found = bySuite.get(binding.suite);
    if (found === undefined || found.passed + found.failed === 0) {
      return criterion;
    }
    const status = found.failed > 0 ? ("not-met" as const) : ("met" as const);
    const refs = [
      `suite:${binding.suite}`,
      `passed:${found.passed}`,
      `failed:${found.failed}`,
    ];
    assessed.push({
      criterionId: criterion.id,
      status,
      suite: binding.suite,
      passed: found.passed,
      failed: found.failed,
    });
    return { ...criterion, status, evidence: refs };
  });

  if (assessed.length === 0) {
    return { task, assessed: [] };
  }
  return {
    task: { ...task, acceptanceCriteria, updatedAt: toIsoString(clock.now()) },
    assessed,
  };
}

export function validateTask(task: Task): void {
  assertNonEmptyString(task.id, "task.id");
  assertNonEmptyString(task.projectId, "task.projectId");
  assertNonEmptyString(task.workspaceId, "task.workspaceId");
  assertNonEmptyString(task.title, "task.title");
  assertNonEmptyString(task.description, "task.description");
  assertStringArray(task.context, "task.context");
  assertStringArray(task.constraints, "task.constraints");
  assertOneOf(task.riskLevel, RISK_LEVELS, "task.riskLevel");
  assertOneOf(task.status, TASK_STATUSES, "task.status");
  validateBudget(task.budget);
  task.verificationStrategy.forEach(validateVerificationStep);

  const criterionIds = new Set<string>();
  task.acceptanceCriteria.forEach((criterion, index) => {
    const id = assertNonEmptyString(
      criterion.id,
      `task.acceptanceCriteria[${index}].id`,
    );
    if (criterionIds.has(id)) {
      throw new DomainError(
        "INVARIANT",
        `duplicate acceptance criterion id "${id}"`,
        { field: "task.acceptanceCriteria" },
      );
    }
    criterionIds.add(id);
    assertNonEmptyString(
      criterion.statement,
      `task.acceptanceCriteria[${index}].statement`,
    );
    assertOneOf(
      criterion.status,
      ACCEPTANCE_CRITERION_STATUSES,
      `task.acceptanceCriteria[${index}].status`,
    );
    validateAcceptanceEvidenceBinding(
      criterion.verifiedBy,
      `task.acceptanceCriteria[${index}].verifiedBy`,
    );
    if (criterion.evidence !== undefined) {
      assertStringArray(
        criterion.evidence,
        `task.acceptanceCriteria[${index}].evidence`,
      );
    }
    if (criterion.verdictBy !== undefined) {
      assertNonEmptyString(
        criterion.verdictBy,
        `task.acceptanceCriteria[${index}].verdictBy`,
      );
    }
    if (criterion.evidence !== undefined && criterion.verdictBy !== undefined) {
      // A status has exactly one source. Both fields present would mean the record
      // claims a verification decided the criterion *and* that a person overruled it,
      // and a reader could not tell which status is being explained.
      throw new DomainError(
        "INVARIANT",
        `acceptance criterion "${id}" carries both verification evidence and a human verdict`,
        { field: `task.acceptanceCriteria[${index}]` },
      );
    }
  });

  const createdAt = assertIsoTimestamp(task.createdAt, "task.createdAt");
  const updatedAt = assertIsoTimestamp(task.updatedAt, "task.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new DomainError(
      "INVARIANT",
      "task.updatedAt must not precede task.createdAt",
      { field: "task.updatedAt" },
    );
  }

  if (task.status === "completed") {
    if (task.completedAt === undefined) {
      throw new DomainError(
        "INVARIANT",
        "a completed task must carry completedAt",
        { field: "task.completedAt" },
      );
    }
  } else if (task.completedAt !== undefined) {
    throw new DomainError(
      "INVARIANT",
      "completedAt may only be set when the task is completed",
      { field: "task.completedAt" },
    );
  }
}
