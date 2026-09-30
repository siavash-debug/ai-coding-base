import type { DomainEvent } from "../observability/events.js";
import type {
  AcceptanceCriterionEvidenceBinding,
  AcceptanceCriterionStatus,
  Task,
  TaskAcceptanceCriterion,
} from "../tasks/task.js";

/**
 * Replays a task's acceptance record from the acceptance events that produced it, and
 * reports every way the persisted record disagrees with that history.
 *
 * The event log is the platform's single source of observability truth (ADR-006), so
 * a task record that cannot be rebuilt from it is a record nobody can audit. Two
 * events establish a criterion — `AcceptanceAssessed`, written by a run from
 * verification the task author bound the criterion to, and `AcceptanceVerdictRecorded`,
 * written by a person (ADR-060, ADR-062) — and this module folds exactly those two, in
 * the order the event store returns them (`occurredAt`, then `sequence`, then `id`:
 * the store's own ordering contract, the same order `ai task trace` uses).
 *
 * ## What is replayed, and what is not
 *
 * The **criteria themselves** — id, statement, and the author's `verifiedBy` binding —
 * are the task's contract, not a projection of the log: `TaskCreated` carries the
 * title, risk and workspace, and the criteria live in the task record. So they are
 * taken as given, and what is replayed is each criterion's *state*: its status, who
 * decided it, and (when a verification decided it) the evidence identity the
 * assessment named.
 *
 * Every rule below is the domain's own rule, not a second interpretation of it
 * (`tasks/task.ts`):
 *
 * - A run assesses **only** a `pending`, explicitly bound criterion, and only from the
 *   evidence that criterion named. An assessment entry therefore names a status the
 *   machine may establish (`met` or `not-met`) plus the suite — and check — it read.
 * - A human verdict establishes `met`, `not-met` or `waived`, **replaces** whatever
 *   the machine recorded, and keeps the author's binding. The replayed criterion
 *   therefore has no machine evidence once a verdict exists.
 * - A criterion a person established is **never** re-assessed. An assessment entry
 *   naming an already-established criterion is reported as an integrity finding and
 *   ignored, because ignoring it is exactly what the domain does.
 *
 * A criterion whose evidence identity the log records but whose `evidence` count
 * references are not restated by the assessment event is compared on identity, and
 * its counts are checked for shape and for internal consistency with its own status
 * rather than for value. That limitation is the reason `AcceptanceAssessed` names the
 * evidence instead of copying it; see the ADR this module is documented in.
 *
 * Findings are deterministic: log-integrity findings first, in fold order, then
 * record divergences in the task's own criterion order. The function is pure — it
 * reads a task and events and mutates neither.
 */
export interface AcceptanceReplay {
  /** Declared criteria on the task record. */
  readonly criteria: number;
  /** `AcceptanceAssessed` events folded for this task. */
  readonly assessments: number;
  /** `AcceptanceVerdictRecorded` events folded for this task. */
  readonly verdicts: number;
  /** Every disagreement, in a stable order. Empty means the record matches the log. */
  readonly findings: readonly string[];
}

/** One criterion's status as the events establish it. Private to this module. */
interface CriterionState {
  status: AcceptanceCriterionStatus;
  verdictBy?: string;
  /** The `suite` or `suite:check` an assessment named, while a machine decided it. */
  assessedFrom?: string;
}

interface AssessmentRef {
  readonly criterionId: string;
  readonly outcome: "met" | "not-met";
  /** The binding the assessment named, as `suite` or `suite:check`. */
  readonly evidence: string;
}

type ParsedRef =
  | { readonly ok: true; readonly ref: AssessmentRef }
  | { readonly ok: false; readonly problem: string };

const PASSED_REF = /^passed:\d+$/;
const FAILED_REF = /^failed:\d+$/;

function criterionLabel(task: Task, criterionId: string): string {
  return `task "${task.id}" criterion "${criterionId}"`;
}

function taskLabel(task: Task): string {
  return `task "${task.id}"`;
}

/**
 * `<criterion-id>:<status>:<suite>[:<check>]` — the reference form `AcceptanceAssessed`
 * records. Splitting on `:` is unambiguous only because the criterion id and the status
 * are both colon-free; everything after them is kept whole, so a suite or check whose
 * own name contains a colon is compared by identity rather than mis-split.
 */
function parseAssessmentRef(ref: string): ParsedRef {
  const parts = ref.split(":");
  const [criterionId, outcome, ...rest] = parts;
  if (criterionId === undefined || outcome === undefined || rest.length === 0) {
    return {
      ok: false,
      problem: `"${ref}" is not <criterion-id>:<status>:<suite>[:<check>]`,
    };
  }
  if (criterionId === "") {
    return { ok: false, problem: `"${ref}" names no criterion` };
  }
  if (outcome !== "met" && outcome !== "not-met") {
    return {
      ok: false,
      problem: `"${ref}" records the status "${outcome}", but an assessment establishes only "met" or "not-met"`,
    };
  }
  const evidence = rest.join(":");
  if (evidence === "") {
    return {
      ok: false,
      problem: `"${ref}" names no verification suite to read the status from`,
    };
  }
  return { ok: true, ref: { criterionId, outcome, evidence } };
}

function foldAssessment(
  task: Task,
  state: ReadonlyMap<string, CriterionState>,
  payload: {
    readonly assessed: number;
    readonly met: number;
    readonly notMet: number;
    readonly criteria: readonly string[];
  },
): string[] {
  const findings: string[] = [];
  const named = new Set<string>();
  let met = 0;
  let notMet = 0;

  for (const ref of payload.criteria) {
    const parsed = parseAssessmentRef(ref);
    if (!parsed.ok) {
      findings.push(
        `${taskLabel(task)}: AcceptanceAssessed reference ${parsed.problem}`,
      );
      continue;
    }
    const { criterionId, outcome, evidence } = parsed.ref;
    // The event's own counts describe its own list, so every reference it lists is
    // counted, whether or not the state advanced: an already-established criterion is
    // reported below rather than silently dropped from the arithmetic.
    if (outcome === "met") {
      met += 1;
    } else {
      notMet += 1;
    }
    if (named.has(criterionId)) {
      findings.push(
        `${criterionLabel(task, criterionId)} is named twice by one assessment`,
      );
      continue;
    }
    named.add(criterionId);

    const criterion = state.get(criterionId);
    if (criterion === undefined) {
      findings.push(
        `${taskLabel(task)}: AcceptanceAssessed names a criterion the task does not declare ("${criterionId}")`,
      );
      continue;
    }
    if (criterion.status !== "pending") {
      // The domain assesses only `pending` criteria, so this cannot be produced by the
      // platform; the finding is the divergence, and the established status stands.
      findings.push(
        `${criterionLabel(task, criterionId)}: the log's own history had it "${criterion.status}" when this assessment ran, and an assessment never overrules an established criterion`,
      );
      continue;
    }

    criterion.status = outcome;
    criterion.assessedFrom = evidence;
    criterion.verdictBy = undefined;
  }

  // The counts the event reports about itself are a claim the record can be wrong about,
  // and the reference list is the part a reader can check it against.
  if (payload.assessed !== payload.criteria.length) {
    findings.push(
      `${taskLabel(task)}: AcceptanceAssessed reports ${payload.assessed} assessment(s) but lists ${payload.criteria.length}`,
    );
  }
  if (payload.met !== met) {
    findings.push(
      `${taskLabel(task)}: AcceptanceAssessed reports ${payload.met} criterion(s) met but lists ${met}`,
    );
  }
  if (payload.notMet !== notMet) {
    findings.push(
      `${taskLabel(task)}: AcceptanceAssessed reports ${payload.notMet} criterion(s) not-met but lists ${notMet}`,
    );
  }
  return findings;
}

/**
 * The evidence references the record must carry for a criterion the log assessed.
 *
 * The shape is the domain's own, per binding (`assessAcceptanceCriteria`): a suite-only
 * binding records `suite:<s>`, and a check-bound one records `check:<c>` and the outcome
 * that status implies ("a failure outranks a pass"). The counts follow in both shapes,
 * and are checked separately, because the assessment event names its evidence rather
 * than restating what it measured.
 */
function expectedEvidence(
  binding: AcceptanceCriterionEvidenceBinding,
  status: AcceptanceCriterionStatus,
): readonly string[] {
  return [
    `suite:${binding.suite}`,
    ...(binding.check === undefined
      ? []
      : [
          `check:${binding.check}`,
          `result:${status === "met" ? "passed" : "failed"}`,
        ]),
  ];
}

function compareEvidence(
  task: Task,
  criterion: TaskAcceptanceCriterion,
  state: CriterionState,
): string[] {
  const findings: string[] = [];
  const label = criterionLabel(task, criterion.id);
  const binding = criterion.verifiedBy;
  if (binding === undefined) {
    findings.push(
      `${label}: the record carries machine evidence for a criterion that declares no binding`,
    );
    return findings;
  }

  // The assessment names the binding it read; the two must be the same claim.
  const declared = `${binding.suite}${binding.check === undefined ? "" : `:${binding.check}`}`;
  if (state.assessedFrom !== declared) {
    findings.push(
      `${label}: the log assessed it from "${state.assessedFrom}", but the record declares the binding "${declared}"`,
    );
    return findings;
  }

  // The identity is compared against the *log's* status: a record whose status was
  // changed is reported by the status comparison, and its evidence is measured against
  // what the log actually recorded rather than against the tampered claim.
  const expected = expectedEvidence(binding, state.status);
  const evidence = criterion.evidence;
  if (evidence === undefined) {
    findings.push(
      `${label}: the record carries no evidence for the "${state.status}" assessment the log records`,
    );
    return findings;
  }
  if (!expected.every((ref, at) => evidence[at] === ref)) {
    findings.push(
      `${label}: the record's evidence does not name the evidence the log records (expected ${expected.join(", ")})`,
    );
    return findings;
  }

  const counts = evidence.slice(expected.length);
  const passed = counts[0];
  const failed = counts[1];
  if (
    counts.length !== 2 ||
    passed === undefined ||
    failed === undefined ||
    !PASSED_REF.test(passed) ||
    !FAILED_REF.test(failed)
  ) {
    findings.push(
      `${label}: the record's evidence names no check counts (expected "passed:<n>", "failed:<n>")`,
    );
    return findings;
  }

  // The counts themselves are the one part of the record the acceptance event does not
  // restate (it names the evidence; `TestCompleted` measures it). What the log does
  // determine is whether a status is possible at all: an assessed criterion read at
  // least one check, a failure outranks a pass, and nothing failed for it to be `met`.
  const passing = Number(passed.slice("passed:".length));
  const failing = Number(failed.slice("failed:".length));
  if (passing + failing === 0) {
    findings.push(
      `${label}: the record carries evidence for an assessed criterion that read no check at all`,
    );
  } else if (criterion.status === "not-met" && failing === 0) {
    findings.push(
      `${label}: the record says "not-met", but its evidence reports no failing check`,
    );
  } else if (criterion.status === "met" && failing > 0) {
    findings.push(
      `${label}: the record says "met", but its evidence reports ${failing} failing check(s)`,
    );
  }
  return findings;
}

function compareCriterion(
  task: Task,
  criterion: TaskAcceptanceCriterion,
  state: CriterionState,
): string[] {
  const findings: string[] = [];
  const label = criterionLabel(task, criterion.id);

  if (criterion.status !== state.status) {
    findings.push(
      `${label}: the record says "${criterion.status}", the log's history says "${state.status}"`,
    );
  }
  if (criterion.verdictBy !== state.verdictBy) {
    findings.push(
      state.verdictBy === undefined
        ? `${label}: the record names "${criterion.verdictBy}" as its author, and the log records no verdict`
        : `${label}: the log records a verdict by "${state.verdictBy}", the record names "${criterion.verdictBy ?? "nobody"}"`,
    );
  }

  if (state.assessedFrom !== undefined) {
    findings.push(...compareEvidence(task, criterion, state));
  } else if (criterion.evidence !== undefined) {
    findings.push(
      `${label}: the record carries machine evidence, and the log records no assessment that produced it`,
    );
  }
  return findings;
}

/**
 * Replays the acceptance record for one task and reports every disagreement, both
 * within the log and between the log and the task record. Purely a read.
 */
export function replayAcceptance(
  task: Task,
  events: readonly DomainEvent[],
): AcceptanceReplay {
  const state = new Map<string, CriterionState>();
  for (const criterion of task.acceptanceCriteria) {
    state.set(criterion.id, { status: "pending" });
  }

  const findings: string[] = [];
  let assessments = 0;
  let verdicts = 0;

  for (const event of events) {
    // Events for another task — and project-scoped events with no task at all — are
    // never acceptance evidence for this one.
    if (event.taskId !== task.id) {
      continue;
    }
    if (event.type === "AcceptanceAssessed") {
      assessments += 1;
      findings.push(...foldAssessment(task, state, event.payload));
      continue;
    }
    if (event.type !== "AcceptanceVerdictRecorded") {
      continue;
    }
    verdicts += 1;
    const verdict = event.payload;
    const criterion = state.get(verdict.criterionId);
    if (criterion === undefined) {
      findings.push(
        `${taskLabel(task)}: AcceptanceVerdictRecorded names a criterion the task does not declare ("${verdict.criterionId}")`,
      );
      continue;
    }
    if (criterion.status !== verdict.from) {
      findings.push(
        `${criterionLabel(task, verdict.criterionId)}: the verdict moved from "${verdict.from}", and the log's own history had it "${criterion.status}" at that point`,
      );
    }
    // A verdict is a person's act and replaces whatever was there, so the record is
    // replayed from `to` whatever `from` said (`markAcceptanceCriterion` has the same
    // rule); the disagreement above is the finding.
    criterion.status = verdict.to;
    criterion.verdictBy = verdict.verdictBy;
    criterion.assessedFrom = undefined;
  }

  for (const criterion of task.acceptanceCriteria) {
    const replayed = state.get(criterion.id);
    if (replayed !== undefined) {
      findings.push(...compareCriterion(task, criterion, replayed));
    }
  }

  return {
    criteria: task.acceptanceCriteria.length,
    assessments,
    verdicts,
    findings,
  };
}
