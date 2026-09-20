import { type Clock, durationMsFrom, toIsoString } from "../core/clock.js";
import { isDomainError } from "../core/errors.js";
import type { IdFactory } from "../core/ids.js";
import { assertNonNegativeInteger } from "../core/validation.js";
import type { ContextConfig } from "../adapters/config/project-config.js";
import {
  type ExclusionDecision,
  exclusionFor,
  parseExclusionPatterns,
  parseIgnoreRules,
} from "../context/ignore.js";
import {
  classifyRef,
  extractPathTokens,
  isTestRef,
  isVerificationConfigRef,
  normalizeRef,
  resolveImports,
  subjectRefsForTest,
  testSiblingRefs,
  tokenSet,
  tokenize,
} from "../context/matching.js";
import {
  DEFAULT_BYTES_PER_TOKEN,
  estimateTokensFromBytes,
  estimateTokensFromText,
} from "../context/tokens.js";
import {
  candidateIdOf,
  orderCandidates,
  scoreCandidate,
} from "../context/scoring.js";
import { admitCandidate } from "../context/budget.js";
import { fingerprint } from "../context/fingerprint.js";
import { MAX_RECORDED_SELECTION_REFS } from "../observability/events.js";
import type {
  ContextBundle,
  ContextBundleItem,
  ContextCandidate,
  ContextExcludedRef,
  ContextItemKind,
  ContextSelection,
  ContextSelectedRef,
  ContextSignal,
  ScoredCandidate,
} from "../context/selection.js";
import type { Project } from "../projects/project.js";
import type { Workspace } from "../workspaces/workspace.js";
import type { ChangeProvider } from "../ports/change-provider.js";
import type {
  ContextEngine,
  ContextSelectRequest,
} from "../ports/context-engine.js";
import type { RepositoryReader } from "../ports/repository-reader.js";
import type { EventRecorder } from "./event-recorder.js";
import { taskCorrelationId } from "./event-recorder.js";

/**
 * The deterministic context engine.
 *
 * Pipeline: **discover → classify → filter → signal → score → order → fit → record**.
 * Every stage is a total function of the repository listing, the task text and the
 * configuration, and every stage's output is visible in the selection the trace
 * records. Nothing here is a model call, and nothing here reads a file it has not
 * already decided to consider.
 *
 * Three properties are load-bearing, and the tests assert them directly:
 *
 * 1. **Determinism.** Two runs over the same state produce the same selection,
 *    byte for byte. Enumeration order is sorted, scoring is additive, ordering is a
 *    total order, and file reads happen only in ranked order.
 * 2. **Explainability.** Every selected candidate carries the reason codes that put
 *    it there, so "why is this file in my prompt?" is answered by arithmetic.
 * 3. **Containment.** Discovery never leaves the workspace, ignore rules and
 *    hard exclusions are applied *before* any read, and the selected text never
 *    enters an event, a trace or a log.
 *
 * One hop of import expansion, not a transitive closure: a closure over a real
 * repository is effectively "read everything", which is the failure mode this
 * engine exists to avoid. One hop captures the module a change touches without
 * pulling the world in behind it.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36 and DECISIONS.md ADR-039/040/041.
 */
export const DETERMINISTIC_ENGINE_ID = "deterministic-context-engine";
export const DETERMINISTIC_STRATEGY = "deterministic";
/**
 * Version of the selection *algorithm*. A behaviour change that would alter what a
 * task receives must bump this, because the number is recorded in every selection
 * and is the only way a later evaluation can tell two runs apart.
 */
export const DETERMINISTIC_SELECTION_VERSION = 1;

/**
 * How many primary candidates may be read to resolve their imports.
 *
 * A bound rather than a configurable: import expansion is the one stage that reads
 * files it will not necessarily select, and an unbounded version would make
 * selection cost proportional to repository size instead of to the task.
 */
export const MAX_IMPORT_SCAN_REFS = 24;

/** Tokens that make a task count as "about architecture". */
const ARCHITECTURE_TOKENS: readonly string[] = [
  "architecture",
  "adr",
  "adrs",
  "decision",
  "decisions",
  "rfc",
  "design",
  "invariant",
  "principle",
  "boundary",
  "isolation",
];

export interface DeterministicContextEngineOptions {
  readonly reader: RepositoryReader;
  readonly changes: ChangeProvider;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly config: ContextConfig;
  readonly project: Project;
  readonly workspace: Workspace;
  readonly selectionIds: IdFactory;
  readonly engineId?: string;
}

function signalsOf(ref: string, kind: ContextItemKind): ContextSignal[] {
  const signals: ContextSignal[] = [];
  if (isVerificationConfigRef(ref)) {
    signals.push("verification-config");
  }
  if (kind === "adr") {
    signals.push("adr");
  } else if (kind === "documentation") {
    signals.push("documentation");
  }
  return signals;
}

export function createDeterministicContextEngine(
  options: DeterministicContextEngineOptions,
): ContextEngine {
  const engineId = options.engineId ?? DETERMINISTIC_ENGINE_ID;
  const config = options.config;
  const bytesPerToken = config.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN;
  const exclusionRules = parseExclusionPatterns(config.exclusions);
  const configFingerprint = fingerprint({
    strategy: DETERMINISTIC_STRATEGY,
    version: DETERMINISTIC_SELECTION_VERSION,
    maxTokens: config.maxTokens,
    bytesPerToken: config.bytesPerToken,
    maxFileTokens: config.maxFileTokens,
    useGitChanges: config.useGitChanges,
    includeTests: config.includeTests,
    includeDocumentation: config.includeDocumentation,
    includeAdr: config.includeAdr,
    exclusions: config.exclusions,
    priority: config.priority,
  });

  /** Kinds an operator has switched off. Recorded as rule exclusions, not silence. */
  function kindDisabled(kind: ContextItemKind): boolean {
    if (kind === "test-file") {
      return !config.includeTests;
    }
    if (kind === "adr") {
      return !config.includeAdr;
    }
    if (kind === "documentation") {
      return !config.includeDocumentation;
    }
    return false;
  }

  return {
    info: {
      id: engineId,
      strategy: DETERMINISTIC_STRATEGY,
      selectionVersion: DETERMINISTIC_SELECTION_VERSION,
      configFingerprint,
    },
    projectId: options.project.id,
    workspaceId: options.workspace.id,

    async select(request: ContextSelectRequest): Promise<{
      readonly selection: ContextSelection;
      readonly bundle: ContextBundle;
    }> {
      const budgetTokens = assertNonNegativeInteger(
        request.budgetTokens,
        "budgetTokens",
      );
      const startedAt = options.clock.now();
      const startedIso = toIsoString(startedAt);
      const selectionId = options.selectionIds.next();
      const scope = {
        workspaceId: options.workspace.id,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.sessionId === undefined
          ? {}
          : { sessionId: request.sessionId }),
        ...(request.taskId === undefined
          ? {}
          : {
              correlationId:
                request.correlationId ??
                taskCorrelationId(
                  options.project.id,
                  options.workspace.id,
                  request.taskId,
                ),
            }),
      };
      const actor = { type: "system" as const, id: engineId };

      await options.recorder.emit({
        type: "ContextSelectionStarted",
        actor,
        ...scope,
        payload: {
          selectionId,
          strategy: DETERMINISTIC_STRATEGY,
          selectionVersion: DETERMINISTIC_SELECTION_VERSION,
          budgetTokens,
          configFingerprint,
        },
      });

      // ---------------------------------------------------------------- discover
      const listing = await options.reader.list();
      const entries = listing.entries;
      const known = new Set(entries.map((entry) => entry.ref));

      const ignoreText = await options.reader.tryRead(".gitignore");
      const ignoreRules = parseIgnoreRules(ignoreText ?? "");

      const changes = config.useGitChanges
        ? await options.changes.changedRefs()
        : { available: false as const, reason: "disabled" as const };
      const changedRefs = new Set(
        changes.available ? (changes.refs ?? []) : [],
      );

      const availableCapabilities: string[] = ["repository"];
      const unavailableCapabilities: string[] = [];
      if (changes.available) {
        availableCapabilities.push("git-changes");
      } else {
        unavailableCapabilities.push(`git-changes:${String(changes.reason)}`);
      }
      if (listing.truncated) {
        unavailableCapabilities.push("repository:listing-truncated");
      }

      // ------------------------------------------------------------------ filter
      let excludedByRules = 0;
      const consideredRefs: string[] = [];
      /**
       * Exclusion decisions are kept, not discarded.
       *
       * A path discovered *later* — as an import target, a test sibling or a
       * directory neighbour — must be refused by exactly the same rules, and a
       * second call could drift from the first. Reusing the decision makes the
       * policy single-valued, which is what lets "no secret ever becomes a
       * candidate" be a property rather than a coincidence of ordering.
       */
      const allowedRefs = new Map<string, boolean>();
      for (const entry of entries) {
        const decision: ExclusionDecision = exclusionFor(entry.ref, {
          ignoreRules,
          exclusionRules,
        });
        const allowed =
          !decision.excluded && !kindDisabled(classifyRef(entry.ref));
        allowedRefs.set(entry.ref, allowed);
        if (!allowed) {
          excludedByRules += 1;
          continue;
        }
        consideredRefs.push(entry.ref);
      }

      // ------------------------------------------------------------------ signal
      const taskTokens = tokenSet(request.taskText);
      const explicit = new Set<string>();
      for (const raw of request.explicitPaths ?? []) {
        const ref = normalizeRef(raw);
        if (ref !== undefined) {
          explicit.add(ref);
        }
      }
      const pathTokens = extractPathTokens([
        ...request.taskText,
        ...(request.explicitPaths ?? []),
      ]);

      const architectureTask = ARCHITECTURE_TOKENS.some((token) =>
        taskTokens.has(token),
      );

      const bytesByRef = new Map<string, number>();
      for (const entry of entries) {
        bytesByRef.set(entry.ref, entry.bytes);
      }

      const candidates = new Map<string, ContextCandidate>();
      const primary: string[] = [];

      for (const ref of consideredRefs) {
        const kind = classifyRef(ref);
        const signals = signalsOf(ref, kind);

        const isExplicit = explicit.has(ref);
        if (isExplicit) {
          signals.push("explicit-path");
        }
        const pathTokenHit = pathTokens.some(
          (token) => ref === token || ref.startsWith(`${token}/`),
        );
        if (pathTokenHit) {
          signals.push("path-token");
        }
        if (changedRefs.has(ref)) {
          signals.push("changed");
        }

        const name = ref.split("/").pop() ?? ref;
        const nameTokens = tokenize(name);
        if (nameTokens.some((token) => taskTokens.has(token))) {
          signals.push("filename-token");
        }

        // A documentation or ADR candidate is only relevant when the task points at
        // it: either a token matches, or the task is about architecture at all.
        const docRelevant =
          kind === "adr"
            ? architectureTask ||
              nameTokens.some((token) => taskTokens.has(token))
            : nameTokens.some((token) => taskTokens.has(token));

        const kept = signals.filter((signal) => {
          if (signal === "adr" || signal === "documentation") {
            return docRelevant;
          }
          return true;
        });

        if (kept.length === 0) {
          continue;
        }

        const tokens = estimateTokensFromBytes(
          bytesByRef.get(ref) ?? 0,
          bytesPerToken,
        );
        const candidate: ContextCandidate = {
          key: candidateIdOf({ kind, ref }),
          kind,
          ref,
          tokens,
          basis: "size",
          signals: kept,
        };
        candidates.set(ref, candidate);
        if (
          isExplicit ||
          pathTokenHit ||
          changedRefs.has(ref) ||
          kept.includes("filename-token")
        ) {
          primary.push(ref);
        }
      }

      // One hop: imports of primary source files, and tests for primary sources
      // (plus the subject of a primary test file).
      const importScan = primary
        .filter((ref) => {
          const kind = classifyRef(ref);
          if (kind !== "source-file" || isTestRef(ref)) {
            return false;
          }
          const bytes = bytesByRef.get(ref) ?? 0;
          if (bytes === 0) {
            return false;
          }
          // Import expansion is the one stage that reads files it may not select,
          // so a file already refused by the per-file cap is not read here either:
          // "never read what cannot be selected" applies to every read, not just
          // the final one.
          return (
            estimateTokensFromBytes(bytes, bytesPerToken) <=
            config.maxFileTokens
          );
        })
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, MAX_IMPORT_SCAN_REFS);

      const linkedTests = new Set<string>();
      for (const ref of primary) {
        if (isTestRef(ref)) {
          for (const subject of subjectRefsForTest(ref)) {
            if (known.has(subject)) {
              linkedTests.add(subject);
            }
          }
          continue;
        }
        for (const sibling of testSiblingRefs(ref)) {
          if (known.has(sibling)) {
            linkedTests.add(sibling);
          }
        }
      }

      const dependencies = new Set<string>();
      for (const ref of importScan) {
        const content = await options.reader.tryRead(ref);
        if (content === undefined) {
          continue;
        }
        for (const dependency of resolveImports(ref, content, known)) {
          if (!dependencies.has(dependency)) {
            dependencies.add(dependency);
          }
        }
      }

      const primaryDirectories = new Set(
        primary.map((ref) => ref.split("/").slice(0, -1).join("/")),
      );

      function addSignal(ref: string, signal: ContextSignal): void {
        if (allowedRefs.get(ref) !== true) {
          return;
        }
        const existing = candidates.get(ref);
        if (existing === undefined) {
          const kind = classifyRef(ref);
          candidates.set(ref, {
            key: candidateIdOf({ kind, ref }),
            kind,
            ref,
            tokens: estimateTokensFromBytes(
              bytesByRef.get(ref) ?? 0,
              bytesPerToken,
            ),
            basis: "size",
            signals: [signal],
          });
          return;
        }
        if (!existing.signals.includes(signal)) {
          candidates.set(ref, {
            ...existing,
            signals: [...existing.signals, signal],
          });
        }
      }

      // A dependency only ever becomes a candidate here, because nothing else
      // could have discovered it: it is not named by the task and may not have
      // changed. Adding it is the point of this stage.
      for (const ref of dependencies) {
        addSignal(ref, "direct-dependency");
      }
      for (const ref of linkedTests) {
        addSignal(ref, "test-relationship");
      }
      for (const ref of consideredRefs) {
        const directory = ref.split("/").slice(0, -1).join("/");
        if (primaryDirectories.has(directory) && !candidates.has(ref)) {
          addSignal(ref, "same-directory");
        }
      }

      // ------------------------------------------------------------------- score
      const scored = [...candidates.values()].map((candidate) =>
        scoreCandidate(candidate, {
          taskTokens,
          priorityRules: config.priority,
        }),
      );
      const ordered = orderCandidates(scored);
      const considered = ordered.length;
      const filteredByScore = consideredRefs.length - considered;

      // --------------------------------------------------------------------- fit
      //
      // Single greedy pass in ranked order, sizing each candidate by its actual
      // content as it is considered. The size estimate is used only as a cheap
      // pre-filter, so a 40MB file is rejected without being read.
      const selected: ContextSelectedRef[] = [];
      const excluded: ContextExcludedRef[] = [];
      const bundleItems: ContextBundleItem[] = [];
      const estimatesOfSelected = new Map<string, number>();
      let candidateTokens = 0;
      let selectedTokens = 0;
      let mandatoryTokens = 0;
      let refusedMandatoryTokens = 0;
      let budgetExceeded = false;

      const isMandatory = (candidate: ScoredCandidate): boolean =>
        candidate.reasons.some((reason) => reason.code === "explicit-path");

      for (const candidate of ordered) {
        candidateTokens += candidate.tokens;
        if (isMandatory(candidate)) {
          mandatoryTokens += candidate.tokens;
        }

        const exclude = (reason: ContextExcludedRef["reason"]): void => {
          excluded.push({
            candidateId: candidate.key,
            kind: candidate.kind,
            ref: candidate.ref,
            tokens: candidate.tokens,
            basis: "size",
            score: candidate.score,
            reason,
          });
          if (reason === "budget-exceeded") {
            budgetExceeded = true;
            refusedMandatoryTokens += candidate.tokens;
          }
        };

        // Cheap rejection before any read: the estimate alone cannot fit, or the
        // file is already known to be too large to be worth reading.
        const estimated = admitCandidate({
          phase: "estimate",
          budgetTokens,
          usedTokens: selectedTokens,
          tokens: candidate.tokens,
          mandatory: isMandatory(candidate),
          maxFileTokens: config.maxFileTokens,
        });
        if (estimated.kind === "exclude") {
          exclude(estimated.reason);
          continue;
        }

        let content: string | undefined;
        try {
          content = await options.reader.read(candidate.ref);
        } catch (error) {
          // A file that vanished between listing and sizing is reported, not
          // silently treated as empty — an empty context item is a lie.
          if (isDomainError(error) && error.code === "NOT_FOUND") {
            exclude("unreadable");
            continue;
          }
          throw error;
        }

        const actualTokens = estimateTokensFromText(content, bytesPerToken);
        const sized = admitCandidate({
          phase: "content",
          budgetTokens,
          usedTokens: selectedTokens,
          tokens: actualTokens,
          mandatory: isMandatory(candidate),
          maxFileTokens: config.maxFileTokens,
        });
        if (sized.kind === "exclude") {
          exclude(sized.reason);
          continue;
        }

        estimatesOfSelected.set(candidate.key, candidate.tokens);
        selectedTokens += actualTokens;
        selected.push({
          candidateId: candidate.key,
          kind: candidate.kind,
          ref: candidate.ref,
          tokens: actualTokens,
          basis: "content",
          score: candidate.score,
          reasons: candidate.reasons.map((reason) => reason.code),
          mandatory: isMandatory(candidate),
        });
        bundleItems.push({
          ref: candidate.ref,
          kind: candidate.kind,
          content,
          tokens: actualTokens,
        });
      }

      const excludedTokens =
        candidateTokens -
        [...estimatesOfSelected.values()].reduce(
          (total, tokens) => total + tokens,
          0,
        );

      const refsTruncated = selected.length > MAX_RECORDED_SELECTION_REFS;
      const recordedSelected = selected.slice(0, MAX_RECORDED_SELECTION_REFS);
      const recordedExcluded = excluded.slice(0, MAX_RECORDED_SELECTION_REFS);
      const durationMs = durationMsFrom(
        startedIso,
        toIsoString(options.clock.now()),
      );

      const selection: ContextSelection = {
        selectionId,
        strategy: DETERMINISTIC_STRATEGY,
        selectionVersion: DETERMINISTIC_SELECTION_VERSION,
        configFingerprint,
        projectId: options.project.id,
        workspaceId: options.workspace.id,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        budgetTokens,
        candidateTokens,
        selectedTokens,
        excludedTokens,
        remainingTokens: Math.max(0, budgetTokens - selectedTokens),
        mandatoryTokens,
        considered,
        selected: recordedSelected,
        excluded: recordedExcluded,
        refsTruncated,
        filteredByScore,
        excludedByRules,
        budgetExceeded,
        overBudgetTokens: budgetExceeded ? refusedMandatoryTokens : 0,
        durationMs,
        capabilities: {
          available: availableCapabilities,
          unavailable: unavailableCapabilities,
        },
        createdAt: toIsoString(options.clock.now()),
      };

      await options.recorder.emit({
        type: "ContextSelected",
        actor,
        ...scope,
        payload: {
          selectionId,
          strategy: selection.strategy,
          selectionVersion: selection.selectionVersion,
          configFingerprint,
          budgetTokens: selection.budgetTokens,
          candidateTokens: selection.candidateTokens,
          selectedTokens: selection.selectedTokens,
          excludedTokens: selection.excludedTokens,
          remainingTokens: selection.remainingTokens,
          mandatoryTokens: selection.mandatoryTokens,
          considered: selection.considered,
          filteredByScore: selection.filteredByScore,
          excludedByRules: selection.excludedByRules,
          budgetExceeded: selection.budgetExceeded,
          overBudgetTokens: selection.overBudgetTokens,
          durationMs: selection.durationMs,
          capabilities: availableCapabilities,
          unavailableCapabilities,
          selectedRefs: recordedSelected,
          excludedRefs: recordedExcluded,
          refsTruncated,
        },
      });

      return {
        selection,
        // An over-budget selection yields no content. The caller must not be able
        // to spend a bundle the budget refused.
        bundle: {
          selectionId,
          selectionVersion: DETERMINISTIC_SELECTION_VERSION,
          items: budgetExceeded ? [] : bundleItems,
        },
      };
    },
  };
}
