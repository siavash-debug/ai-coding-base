/**
 * RepositoryReader port: the read-only filesystem view a context selection is
 * built from.
 *
 * Deliberately tiny, and deliberately read-only. There is no `write`, no `delete`
 * and no `exec`: context selection must not be able to change the workspace it is
 * reading, and a port that cannot express mutation is a stronger guarantee than a
 * convention that says not to.
 *
 * The port is bound to exactly one workspace root at construction, so a reader
 * cannot be pointed at another project's tree mid-selection, and `ref`s are
 * workspace-relative POSIX paths rather than absolute paths — an absolute path in a
 * candidate would survive into a trace and leak the operator's directory layout.
 *
 * Listing is *not* filtered by ignore rules. Ignore rules are policy, policy is
 * traceable, and the engine must be able to report how many paths it excluded and
 * why. The adapter's only filtering is the one that is purely about cost — it does
 * not descend into hard-excluded directories such as `node_modules` — because
 * reading them to then discard them would be theatre.
 *
 * See docs/architecture/V2-ARCHITECTURE.md §36.2 and DECISIONS.md ADR-041.
 */
export interface RepositoryEntry {
  /** Workspace-relative POSIX path. Never absolute, never containing `..`. */
  readonly ref: string;
  /** Size in bytes, used for token estimation before the file is read. */
  readonly bytes: number;
}

export interface RepositoryListing {
  readonly entries: readonly RepositoryEntry[];
  /**
   * True when the walk stopped at its entry cap. Recorded rather than hidden: a
   * selection made over a truncated listing is not the same selection, and a trace
   * that omitted this would be quietly wrong.
   */
  readonly truncated: boolean;
}

export interface RepositoryReader {
  readonly id: string;
  /** Every readable file in the workspace, ordered by `ref`. */
  list(): Promise<RepositoryListing>;
  /** Reads a file's text. Throws `NOT_FOUND` when it does not exist. */
  read(ref: string): Promise<string>;
  /** Reads a file's text, or `undefined` when it does not exist. */
  tryRead(ref: string): Promise<string | undefined>;
}
