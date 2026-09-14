/**
 * Typed error taxonomy. Invariant I6 is why it exists: an error that escapes a
 * module is allowed to carry three things and nothing else:
 *
 *   - a `category`, so callers branch on a symbol instead of a message string
 *   - a short human message describing WHAT failed, never the value that failed
 *   - the `swap_id` the failure belongs to
 *
 * There is deliberately no `cause`. A wrapped cause (a zod error, a cashu-ts
 * error) is the usual way a token string ends up in a log line.
 */

export const ERROR_CATEGORIES: readonly string[] = [
  /** Operator configuration is unusable: bad nsec, bad relay URL, bad env. */
  'config_invalid',
  /** A JSON payload failed its schema. */
  'content_invalid',
  /** An event failed id/signature verification. */
  'event_invalid',
  /** A gift wrap could not be opened or its sender could not be authenticated. */
  'private_lane_invalid',
  /** Every configured relay refused or failed the operation. */
  'relay_unavailable',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export type EscrowErrorContext = {
  /** The swap this failure belongs to, when there is one. */
  swapId?: string;
};

export class EscrowError extends Error {
  readonly category: ErrorCategory;
  readonly swapId: string | undefined;

  constructor(
    category: ErrorCategory,
    message: string,
    context: EscrowErrorContext = {}
  ) {
    super(message);
    this.name = 'EscrowError';
    this.category = category;
    this.swapId = context.swapId;
  }
}

export function isEscrowError(value: unknown): value is EscrowError {
  return value instanceof EscrowError;
}
