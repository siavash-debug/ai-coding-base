import { afterEach, describe, expect, it } from "vitest";

import {
  DECISION_QUALITY_ANSWERED_BY,
  DECISION_QUALITY_FINAL_STATUSES,
  buildDecisionQualityReport,
  wasDecisionLayerConsulted,
} from "../../src/application/decision-quality.js";
import { DECISION_LAYER_DISABLED_REASON } from "../../src/decisions/domains.js";
import { DECISION_DOMAINS } from "../../src/decisions/domains.js";
import {
  FIXTURE_USAGE,
  TEXT_MODEL,
  createScriptedFrontier,
  frontierConfig,
  ratesFor,
} from "../support/frontier.js";
import { createTestProject, type TestProject } from "../support/project.js";

/**
 * The Decision Quality report as a projection.
 *
 * The benchmark exercises it across ten representative tasks; this file covers the two
 * things a benchmark run cannot show on its own: what the report says when the platform
 * runs with **no decision layer at all** (its default configuration), and the closed
 * vocabularies the report promises to answer with. The point of the second one is that
 * a report which invented a new status or a new answer source would silently break
 * every consumer that counts them.
 */

const projects: TestProject[] = [];

afterEach(async () => {
  while (projects.length > 0) {
    await projects.pop()?.cleanup();
  }
});

async function reportWithoutDecisionLayer() {
  const frontier = createScriptedFrontier([
    { content: "Fixed src/parser.ts.", usage: FIXTURE_USAGE },
  ]);
  const project = await createTestProject({
    frontierConfig: frontierConfig({ models: [TEXT_MODEL] }),
    modelRates: ratesFor([TEXT_MODEL]),
    frontier,
    // No decision provider: this is the platform's default, and it must keep working
    // (ADR-004, ADR-052).
  });
  projects.push(project);

  const stored = await project.runtime.tasks.create(
    {
      title: "Fix the parser bug in src/parser.ts.",
      description: "Fix the parser bug in src/parser.ts.",
      acceptanceCriteria: ["The parser accepts the documented format"],
    },
    { project: project.runtime.project, workspace: project.runtime.workspace },
  );
  const taskId = String(stored.task.id);
  const result = await project.runtime.orchestrator.run({
    workspaceId: project.runtime.workspace.id,
    taskId: taskId as never,
  });
  const scope = {
    projectId: project.runtime.project.id,
    workspaceId: project.runtime.workspace.id,
  };
  const trace = await project.runtime.traces.read(scope, taskId as never);
  return {
    report: buildDecisionQualityReport({ result, trace }),
    frontierCalls: frontier.calls,
  };
}

describe("the decision quality report", () => {
  it("answers honestly with no decision layer installed", async () => {
    const { report, frontierCalls } = await reportWithoutDecisionLayer();

    expect(frontierCalls).toBe(1);
    expect(report.modelCalls).toBe(1);
    expect(report.executionStrategy.answeredBy).toBe("code");
    // Nothing was consulted, and the report says so rather than crediting a layer
    // that was never there.
    expect(wasDecisionLayerConsulted(report)).toBe(false);
    expect(report.decisionsAnsweredByProvider).toBe(0);
    for (const decision of report.decisions) {
      expect(decision.answeredBy).not.toBe("provider");
      expect(decision.providerCalls).toBe(0);
    }
    // The questions that *were* asked carry the reason code that distinguishes "not
    // configured" from "configured and certain".
    expect(report.decisions.map((decision) => decision.reasonCode)).toContain(
      DECISION_LAYER_DISABLED_REASON,
    );
    // And the outcome is the conservative one: a successful step is not a verified
    // task, so the run is reported as needing review rather than completed.
    expect(report.completion.selectedOptionId).toBe("uncertain");
    expect(report.completionAssessment).toBe("uncertain");
    expect(report.finalStatus).toBe("needs-review");
  });

  it("reports a question that was never asked as not-asked, not as an answer", async () => {
    const { report } = await reportWithoutDecisionLayer();

    // The orchestration path asks the model-ranking and completion questions; it does
    // not ask the attempt-level routing question, and no failure means no retry
    // question. Absence is absence.
    expect(report.routing).toBeUndefined();
    expect(report.retries).toEqual([]);
    // Every reported decision is one the platform has a domain for — the report cannot
    // invent a question, and the closed vocabulary is what makes that checkable.
    for (const decision of report.decisions) {
      expect(DECISION_DOMAINS).toContain(decision.domain);
      expect(DECISION_QUALITY_ANSWERED_BY).toContain(decision.answeredBy);
    }
    expect(DECISION_QUALITY_FINAL_STATUSES).toContain(report.finalStatus);
  });

  it("reports an absent context selection as absence rather than as an empty one", async () => {
    const { report } = await reportWithoutDecisionLayer();

    // The Context Engine selects above this layer (ADR-018/ADR-039). When it did not
    // run, the report says there was no selection — it does not claim to have kept
    // nothing.
    expect(report.context.selectionCount).toBe(0);
    expect(report.context.selectedItems).toBe(0);
    expect(report.context.selectedRefs).toEqual([]);
    expect(report.context.selectedTokens).toBeUndefined();
    expect(report.context.budgetTokens).toBeUndefined();
  });
});
