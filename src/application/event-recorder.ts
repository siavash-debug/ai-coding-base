import type { Clock } from "../core/clock.js";
import { DomainError } from "../core/errors.js";
import {
  type IdFactory,
  type ProjectId,
  type SessionId,
  type TaskId,
  type WorkspaceId,
  eventId as toEventId,
} from "../core/ids.js";
import {
  type DomainEvent,
  type EventActor,
  type EventEnvelope,
  type EventPayloadMap,
  type EventType,
  createEvent,
  nextSequence,
} from "../observability/events.js";
import type { EventStore } from "../ports/event-store.js";

/**
 * The single place that assigns event identity and sequence.
 *
 * Concentrating this is what makes the log trustworthy: services describe *what
 * happened* and the recorder owns *where it goes in the stream*. It also enforces
 * the traceability rule that an event carrying a `sessionId` must also carry its
 * `taskId`, so `Task → Session → Event` is never a broken chain
 * (V2-ARCHITECTURE §17.2).
 */
export interface EmitInput<K extends EventType> {
  readonly type: K;
  readonly workspaceId: WorkspaceId;
  readonly actor: EventActor;
  readonly payload: EventPayloadMap[K];
  readonly taskId?: TaskId;
  readonly sessionId?: SessionId;
  readonly correlationId?: string;
}

export interface EventRecorder {
  emit<K extends EventType>(input: EmitInput<K>): Promise<EventEnvelope<K>>;
  /** Highest sequence already written for a workspace stream (0 when empty). */
  lastSequence(workspaceId: WorkspaceId): Promise<number>;
}

export interface EventRecorderDeps {
  readonly store: EventStore;
  readonly projectId: ProjectId;
  readonly clock: Clock;
  readonly eventIds: IdFactory;
}

/**
 * Correlation id shared by every event of one task, in the RFC's
 * `project:workspace:task` form.
 */
export function taskCorrelationId(
  projectId: ProjectId,
  workspaceId: WorkspaceId,
  taskId: TaskId,
): string {
  return `${projectId}:${workspaceId}:${taskId}`;
}

export function createEventRecorder(deps: EventRecorderDeps): EventRecorder {
  const lastSequences = new Map<string, number>();
  /**
   * Emits are serialized per recorder. Two concurrent callers cannot be handed
   * the same sequence, and the store's ordering check cannot fail because of a
   * race inside this process.
   */
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = chain.then(work, work);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function seed(workspaceId: WorkspaceId): Promise<number> {
    if (!lastSequences.has(workspaceId)) {
      const existing = await deps.store.readAll({
        projectId: deps.projectId,
        workspaceId,
      });
      lastSequences.set(workspaceId, nextSequence(existing) - 1);
    }
    return lastSequences.get(workspaceId) ?? 0;
  }

  function lastSequence(workspaceId: WorkspaceId): Promise<number> {
    return enqueue(() => seed(workspaceId));
  }

  function emit<K extends EventType>(
    input: EmitInput<K>,
  ): Promise<EventEnvelope<K>> {
    return enqueue(async () => {
      if (input.sessionId !== undefined && input.taskId === undefined) {
        throw new DomainError(
          "INVARIANT",
          `event "${input.type}" carries a sessionId without a taskId`,
          { field: "taskId" },
        );
      }
      const sequence = (await seed(input.workspaceId)) + 1;
      const event = createEvent(
        {
          type: input.type,
          actor: input.actor,
          projectId: deps.projectId,
          workspaceId: input.workspaceId,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          ...(input.sessionId === undefined
            ? {}
            : { sessionId: input.sessionId }),
          ...(input.correlationId === undefined
            ? {}
            : { correlationId: input.correlationId }),
          payload: input.payload,
        },
        {
          id: toEventId(deps.eventIds.next()),
          sequence,
          clock: deps.clock,
        },
      );
      // `event` is one specific member of the `DomainEvent` union, but a generic
      // `EventEnvelope<K>` cannot be proven assignable to that union by the
      // compiler. The runtime value is exactly a union member.
      await deps.store.append(event as DomainEvent);
      lastSequences.set(input.workspaceId, sequence);
      return event;
    });
  }

  return { emit, lastSequence };
}
