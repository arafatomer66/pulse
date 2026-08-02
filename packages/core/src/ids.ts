import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';

/**
 * Identifier and API-key primitives.
 *
 * API keys follow the same posture as sharedeal-social's session tokens: the
 * plaintext is shown exactly once at creation and only its sha256 is stored, so
 * a database leak cannot be replayed against the API.
 */

export type KeyPrefix = 'pk_live' | 'pk_test';

/** ULIDs sort lexically by creation time, which is what the inbox and delivery
 *  log range keys rely on for "newest first" without a separate sort attribute. */
export const newId = (): string => ulid();
export const newMessageId = (): string => ulid();

export function newTenantId(): string {
  return `ten_${randomBytes(12).toString('hex')}`;
}

export function newSubscriberId(): string {
  return `sub_${randomBytes(12).toString('hex')}`;
}

export function newEndpointId(): string {
  return `whe_${randomBytes(12).toString('hex')}`;
}

export function newKeyId(): string {
  return `key_${randomBytes(8).toString('hex')}`;
}

export interface GeneratedApiKey {
  /** Shown to the user once, never persisted. */
  plaintext: string;
  hash: string;
  last4: string;
  prefix: KeyPrefix;
}

export function generateApiKey(prefix: KeyPrefix = 'pk_live'): GeneratedApiKey {
  const secret = randomBytes(32).toString('hex');
  const plaintext = `${prefix}_${secret}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    last4: secret.slice(-4),
    prefix,
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Parse the prefix without trusting it — used only to pick the lookup path. */
export function apiKeyPrefix(plaintext: string): KeyPrefix | null {
  if (plaintext.startsWith('pk_live_')) return 'pk_live';
  if (plaintext.startsWith('pk_test_')) return 'pk_test';
  return null;
}

/** Constant-time compare for webhook signature verification helpers. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Unix seconds, for DynamoDB TTL attributes. */
export function ttlSeconds(daysFromNow: number, from = new Date()): number {
  return Math.floor(from.getTime() / 1000) + daysFromNow * 86_400;
}

export function ttlSecondsFromHours(hours: number, from = new Date()): number {
  return Math.floor(from.getTime() / 1000) + hours * 3_600;
}
