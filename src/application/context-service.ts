import type { ContextConfig } from "../adapters/config/project-config.js";
import type { ContextBundle, ContextSelection } from "../context/selection.js";
import type { SessionId } from "../core/ids.js";
import type { ContextEngine } from "../ports/context-engine.js";
import type { Task } from "../tasks/task.js";
import { taskCorrelationId } from "./event-recorder.js";

/**
 * Turning a task into a context request, in one place.
 *
 * Both the run use case and `ai task context` need the same answer to "what text
 * does this task offer, and what budget applies?", and a second implementation
 * would drift: the command would report a selection the run would never make. So
 * the mapping lives here, once, and both callers stay thin.
 */
export function taskContextText(task: Task): readonly string[] {
  return [
    task.title,
    task.description,
    ...task.context,
    ...task.constraints,
    ...task.acceptanceCriteria.map((criterion) => criterion.statement),
  ];
}

/**
 * The budget a selection for this task runs under.
 *
 * The smaller of the project's context budget and the task's own token budget.
 * They answer different questions — "how much may I read?" and "how much may I
 * spend?" — but a task that declared a 500-token budget must not be handed 8,000
 * tokens of context and then fail its own spend gate for doing exactly what it was
 * read. Recording it as the selection's `budgetTokens` keeps the effective bound
 * visible rather than implied (ADR-040).
 */
export function effectiveContextBudget(
  config: ContextConfig,
  task: Task,
): number {
  const taskBudget = task.budget.maxTokens;
  return taskBudget === undefined
    ? config.maxTokens
    : Math.min(config.maxTokens, taskBudget);
}

/**
 * Selects context for a task: metadata for the record, content for one prompt.
 *
 * A thin wrapper, on purpose. The engine owns selection; this owns *which task
 * fields become the request*. Both halves come back together so a caller cannot
 * pair one task's metadata with another task's content.
 */
export async function selectContextForTask(
  deps: {
    readonly context: ContextEngine;
    readonly contextConfig: ContextConfig;
  },
  task: Task,
  options?: { readonly sessionId?: SessionId },
): Promise<{
  readonly selection: ContextSelection;
  readonly bundle: ContextBundle;
}> {
  return await deps.context.select({
    taskText: taskContextText(task),
    explicitPaths: task.context,
    budgetTokens: effectiveContextBudget(deps.contextConfig, task),
    taskId: task.id,
    ...(options?.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    correlationId: taskCorrelationId(task.projectId, task.workspaceId, task.id),
  });
}
