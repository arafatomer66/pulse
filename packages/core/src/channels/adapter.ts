import type { ChannelJob, SendOutcome } from '../types';

/**
 * Every channel implements exactly this.
 *
 * Adapters must NOT throw for expected provider failures — they return an
 * outcome with `retryable`, and the worker decides retry-vs-DLQ from that. An
 * adapter throwing means something unexpected happened (bad config, a bug), and
 * the worker treats it as retryable.
 */
export interface ChannelAdapter {
  readonly name: string;
  send(job: ChannelJob): Promise<SendOutcome>;
}

/**
 * Provider errors we should retry: throttling, timeouts, 5xx. Everything else —
 * a malformed address, a revoked token, a rejected sender — will fail the same
 * way forever, so retrying it just burns quota and delays the DLQ.
 */
export function isRetryableProviderError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return true;

  const name = 'name' in e ? String((e as { name: unknown }).name) : '';
  const status =
    '$metadata' in e
      ? ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0)
      : 0;

  if (status >= 500) return true;
  if (status === 429) return true;
  if (status >= 400 && status < 500) return false;

  return [
    'ThrottlingException',
    'TooManyRequestsException',
    'ServiceUnavailable',
    'RequestTimeout',
    'TimeoutError',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
  ].some((n) => name.includes(n));
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
