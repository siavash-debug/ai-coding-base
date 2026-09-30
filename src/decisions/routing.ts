import type { DecisionKind } from "./decision.js";
import type { DecisionProvider, DecisionRequest } from "./provider.js";
import { providerCanHandle } from "./provider.js";

/**
 * Deterministic provider routing.
 *
 * Routing is itself a bounded decision, and it is answered in code: enabled
 * registrations supporting the kind, lowest priority first, ties broken by
 * provider id. No randomness, no time, no I/O — so "which engine decided this?"
 * is reproducible.
 * See docs/architecture/V2-ARCHITECTURE.md §8.3.
 */
export interface DecisionProviderRegistration {
  readonly providerId: string;
  readonly kinds: readonly DecisionKind[];
  /** Lower wins. */
  readonly priority: number;
  readonly enabled: boolean;
}

export function candidateRegistrations(
  registrations: readonly DecisionProviderRegistration[],
  kind: DecisionKind,
): readonly DecisionProviderRegistration[] {
  return registrations
    .filter((registration) => registration.enabled)
    .filter((registration) => registration.kinds.includes(kind))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.providerId < b.providerId
          ? -1
          : a.providerId > b.providerId
            ? 1
            : 0),
    );
}

export function selectDecisionProvider(
  registrations: readonly DecisionProviderRegistration[],
  kind: DecisionKind,
): DecisionProviderRegistration | undefined {
  return candidateRegistrations(registrations, kind)[0];
}

/**
 * Selects the first registered provider that both matches the routing order and
 * can actually handle the bounded request. Returns `undefined` when the ladder
 * must continue to another layer.
 */
export function routeDecision(
  providers: readonly DecisionProvider[],
  registrations: readonly DecisionProviderRegistration[],
  request: DecisionRequest,
): DecisionProvider | undefined {
  for (const registration of candidateRegistrations(
    registrations,
    request.kind,
  )) {
    const provider = providers.find(
      (candidate) => candidate.id === registration.providerId,
    );
    if (provider !== undefined && providerCanHandle(provider, request)) {
      return provider;
    }
  }
  return undefined;
}
