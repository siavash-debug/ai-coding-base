import {
  type DomainError,
  type DomainErrorCode,
  hasDomainErrorCode,
} from "../../src/core/errors.js";

/**
 * Runs `fn`, asserts it threw a DomainError carrying `code`, and returns it.
 * Throwing is deliberate: a plain Error gives a clear vitest failure message.
 * The final cast is safe because the runtime check above already proved it.
 */
export function expectDomainError(
  fn: () => unknown,
  code: DomainErrorCode,
): DomainError {
  let thrown: unknown;
  let didThrow = false;
  try {
    fn();
  } catch (error) {
    thrown = error;
    didThrow = true;
  }
  if (!didThrow) {
    throw new Error(
      `expected a DomainError with code ${code}, but nothing was thrown`,
    );
  }
  if (!hasDomainErrorCode(thrown, code)) {
    const actual =
      thrown instanceof Error
        ? `${thrown.name}: ${thrown.message}`
        : String(thrown);
    throw new Error(`expected a DomainError with code ${code}, got ${actual}`);
  }
  return thrown as DomainError;
}
