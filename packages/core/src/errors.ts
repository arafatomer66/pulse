/**
 * Stable error-code catalog. Clients switch on `code`, never on `message` —
 * messages may be reworded, codes may not.
 *
 * Mirrors the pattern in sharedeal-social/api/src/common/error-codes.ts, but
 * carries a bare HTTP status number so @pulse/core stays free of NestJS.
 */

export const ERROR_CODES = Object.freeze({
  // --- auth / tenancy ---
  UNAUTHENTICATED: 401,
  INVALID_API_KEY: 401,
  KEY_REVOKED: 401,
  FORBIDDEN_SCOPE: 403,
  TENANT_SUSPENDED: 403,

  // --- request shape ---
  VALIDATION_FAILED: 422,
  MISSING_IDEMPOTENCY_KEY: 400,
  IDEMPOTENCY_KEY_REUSED: 409,

  // --- resources ---
  TENANT_NOT_FOUND: 404,
  TEMPLATE_NOT_FOUND: 404,
  SUBSCRIBER_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  WEBHOOK_NOT_FOUND: 404,
  DUPLICATE_RESOURCE: 409,

  // --- send-path ---
  NO_DELIVERABLE_CHANNEL: 422,
  MISSING_CHANNEL_DESTINATION: 422,
  TEMPLATE_RENDER_FAILED: 422,
  MESSAGE_NOT_CANCELLABLE: 409,
  SCHEDULE_IN_PAST: 422,

  // --- limits ---
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,

  // --- infrastructure ---
  PROVIDER_ERROR: 502,
  INTERNAL_ERROR: 500,
} as const);

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Domain error carrying a catalog code. The API's exception filter turns this
 * into `{ error: { code, message, details? } }` with the catalog's status.
 */
export class PulseError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'PulseError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
    Error.captureStackTrace?.(this, PulseError);
  }
}

export function isPulseError(e: unknown): e is PulseError {
  return e instanceof PulseError;
}
