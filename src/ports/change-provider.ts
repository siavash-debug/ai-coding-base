/**
 * ChangeProvider port: "what has changed recently?", answered deterministically.
 *
 * Git is the obvious source, but it is deliberately not required anywhere. A
 * selection that depended on a git checkout would be unavailable in an exported
 * tarball, a shallow CI clone or a workspace that is not a repository at all — and
 * worse, it would make the *same task* select different context in those
 * environments without saying so.
 *
 * So capability is reported, never assumed. `available: false` carries a reason
 * code, and the trace records it, which is what allows a reviewer to see that a
 * selection was made without change information rather than to infer it.
 *
 * Paths are workspace-relative POSIX refs for the same reason as
 * `RepositoryReader`, and a provider that cannot answer must say so rather than
 * return an empty change set: "nothing changed" and "I cannot tell" are different
 * facts and only one of them is safe to select on.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.7 and DECISIONS.md ADR-042.
 */
export const CHANGE_UNAVAILABLE_REASONS = [
  /** No version-control executable, or it could not be run. */
  "no-vcs",
  /** The workspace is not inside a repository work tree. */
  "not-a-repository",
  /** The repository exists but the query failed (permissions, corrupt index). */
  "query-failed",
  /** Calls were disabled by configuration. */
  "disabled",
] as const;

export type ChangeUnavailableReason =
  (typeof CHANGE_UNAVAILABLE_REASONS)[number];

export interface ChangedPaths {
  readonly available: boolean;
  /** Present when `available` is true. Workspace-relative POSIX refs. */
  readonly refs?: readonly string[];
  /** Present when `available` is false. */
  readonly reason?: ChangeUnavailableReason;
  /** Identifier of the revision the answer is relative to, when known. */
  readonly revision?: string;
}

export interface ChangeProvider {
  readonly id: string;
  /**
   * Never throws for an environmental problem: an unavailable provider is reported
   * as unavailable. A programming error still propagates.
   */
  changedRefs(): Promise<ChangedPaths>;
}
