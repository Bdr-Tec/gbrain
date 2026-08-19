/**
 * AI service error hierarchy. Three classes mapping to caller decisions:
 *
 *   AIConfigError     — user fixes: bad key, missing model, dim mismatch.
 *                       Abort + show recovery recipe.
 *   AITransientError  — retryable: SDK retries exhausted, rate limit sustained.
 *                       Propagate so job queue can retry later.
 *   AIServiceError    — base class for both.
 *
 * The `fix` field carries a human-readable recovery recipe agents and humans
 * can act on. The `cause` field preserves the underlying SDK error.
 */

export class AIServiceError extends Error {
  /**
   * HTTP status of the underlying API failure, carried through top-level by
   * `normalizeAIError` when the wrapped error exposes one (e.g. the claude-cli
   * provider's ClaudeCliProcessError.apiErrorStatus), so callers can branch on
   * it without digging into `cause`.
   */
  apiErrorStatus?: number;
  /** HTTP status carried through from a wrapped error's own `status` field. */
  status?: number;

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AIServiceError';
  }
}

export class AIConfigError extends AIServiceError {
  constructor(
    message: string,
    public readonly fix?: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'AIConfigError';
  }
}

export class AITransientError extends AIServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AITransientError';
  }
}

/**
 * Normalize any thrown error into our hierarchy. AI SDK errors are inspected
 * by status code + name; unknown errors default to AITransientError so the
 * caller does not permanently abort on a transient network blip.
 */
/**
 * Copy status fields from the wrapped error onto the normalized error's top
 * level (same property names), so typed information like the claude-cli
 * provider's `apiErrorStatus` stays reachable without unwrapping `cause`.
 */
function carryStatusFields(from: unknown, to: AIServiceError): AIServiceError {
  const src = from as { apiErrorStatus?: unknown; status?: unknown } | null | undefined;
  if (src && typeof src === 'object') {
    if (typeof src.apiErrorStatus === 'number') to.apiErrorStatus = src.apiErrorStatus;
    if (typeof src.status === 'number') to.status = src.status;
  }
  return to;
}

export function normalizeAIError(err: unknown, context?: string): AIServiceError {
  if (err instanceof AIServiceError) return err;

  const anyErr = err as { name?: string; status?: number; statusCode?: number; message?: string };
  const status = anyErr?.status ?? anyErr?.statusCode;
  const name = anyErr?.name ?? '';
  const msg = anyErr?.message ?? String(err);
  const ctxPrefix = context ? `[${context}] ` : '';

  // 4xx (except 429) = config-level, non-retryable
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return carryStatusFields(err, new AIConfigError(
      `${ctxPrefix}${msg}`,
      status === 401 || status === 403
        ? 'Check your API key is valid and has access to this model.'
        : 'Check your model id + provider options match the provider API.',
      err,
    ));
  }

  // AI SDK named errors
  if (name === 'LoadAPIKeyError' || name === 'InvalidArgumentError') {
    return carryStatusFields(err, new AIConfigError(`${ctxPrefix}${msg}`, undefined, err));
  }

  // Everything else (5xx, timeouts, network) = transient
  return carryStatusFields(err, new AITransientError(`${ctxPrefix}${msg}`, err));
}
