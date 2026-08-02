/**
 * Domain types shared by the API and the workers.
 *
 * Everything here is plain data — no AWS SDK types leak out of this file, so the
 * same shapes are used by the local runner, the Lambda handlers and the tests.
 */

export const CHANNELS = ['email', 'push', 'sms', 'inapp', 'webhook'] as const;
export type Channel = (typeof CHANNELS)[number];

export const LOCALES = ['en', 'bn'] as const;
export type Locale = (typeof LOCALES)[number];

/** Per-channel delivery outcome. `suppressed` is a success-ish terminal state: we
 *  deliberately did not send, and that is not a failure to retry. */
export type DeliveryStatus =
  | 'queued'
  | 'delivered'
  | 'failed'
  | 'suppressed'
  | 'skipped'
  | 'cancelled';

/** Roll-up across all channels of one message. */
export type MessageStatus =
  | 'queued'
  | 'scheduled'
  | 'processing'
  | 'delivered'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type Plan = 'free' | 'growth' | 'scale';

export interface Tenant {
  tenantId: string;
  name: string;
  plan: Plan;
  status: 'active' | 'suspended';
  monthlyQuota: number;
  rateLimitPerMin: number;
  retentionDays: number;
  createdAt: string;
}

export const SCOPES = [
  'notifications:send',
  'notifications:read',
  'subscribers:write',
  'subscribers:read',
  'templates:write',
  'templates:read',
  'inbox:read',
  'webhooks:write',
] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKeyRecord {
  keyHash: string;
  keyId: string;
  tenantId: string;
  name: string;
  prefix: 'pk_live' | 'pk_test';
  /** Last 4 chars of the plaintext, so the console can show `pk_live_…a3f9`. */
  last4: string;
  scopes: Scope[];
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt?: string;
}

/** One channel's body within a template. Absent channel = template does not
 *  support it, and a send targeting that channel is `skipped`, not failed. */
export interface TemplateBodies {
  email?: { subject: string; html: string; text?: string };
  push?: { title: string; body: string; imageUrl?: string; data?: Record<string, string> };
  sms?: { text: string };
  inapp?: { title: string; body: string; deeplink?: string };
  webhook?: { event: string; payload?: string };
}

export interface Template {
  tenantId: string;
  key: string;
  version: number;
  name: string;
  /** Category drives per-subscriber opt-out (`prefs.categories`). */
  category: string;
  /** `en` is required and acts as the fallback when a locale is missing. */
  locales: { en: TemplateBodies } & Partial<Record<Locale, TemplateBodies>>;
  createdAt: string;
}

export interface SubscriberPreferences {
  /** Channel-level master switches. Missing channel = opted in. */
  channels: Partial<Record<Channel, boolean>>;
  /** Category-level switches, e.g. `{ marketing: false }`. Missing = opted in. */
  categories: Record<string, boolean>;
}

export interface Subscriber {
  tenantId: string;
  subscriberId: string;
  email?: string;
  phone?: string;
  locale: Locale;
  timezone: string;
  /** Tenant's own user id, for lookup without storing Pulse ids on their side. */
  externalId?: string;
  attributes: Record<string, unknown>;
  preferences: SubscriberPreferences;
  topics: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DeviceToken {
  tenantId: string;
  subscriberId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  appVersion?: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface ChannelResult {
  channel: Channel;
  status: DeliveryStatus;
  providerMessageId?: string;
  error?: string;
  /** Why we did not send — populated for `suppressed` / `skipped`. */
  reason?: string;
  attempts: number;
  updatedAt: string;
}

export interface Message {
  messageId: string;
  tenantId: string;
  subscriberId?: string;
  templateKey?: string;
  category: string;
  locale: Locale;
  channels: Channel[];
  status: MessageStatus;
  /** Rendered-at-send-time payloads, kept for the delivery log and for retries
   *  so a template edit never changes what an in-flight message says. */
  rendered: Partial<Record<Channel, unknown>>;
  data: Record<string, unknown>;
  /**
   * Keyed by channel, NOT a list. Up to five workers update one message
   * concurrently; a map lets each write only its own key (`SET results.#ch`),
   * which is atomic. A list would force read-modify-write and lose updates.
   */
  results: Partial<Record<Channel, ChannelResult>>;
  scheduledFor?: string;
  createdAt: string;
  updatedAt: string;
  /** Unix seconds; DynamoDB TTL reaps the log per the tenant's retention. */
  expiresAt: number;
}

export interface InboxItem {
  tenantId: string;
  subscriberId: string;
  itemId: string;
  messageId: string;
  title: string;
  body: string;
  deeplink?: string;
  category: string;
  readAt?: string;
  createdAt: string;
  expiresAt: number;
}

export interface SuppressionEntry {
  tenantId: string;
  channel: Channel;
  /** Email address, E.164 phone, or device token. */
  address: string;
  reason: 'bounce' | 'complaint' | 'unsubscribe' | 'invalid' | 'manual';
  detail?: string;
  createdAt: string;
}

export interface WebhookEndpoint {
  tenantId: string;
  endpointId: string;
  url: string;
  /** HMAC-SHA256 signing secret; returned in full only at creation time. */
  secret: string;
  events: string[];
  status: 'active' | 'disabled';
  createdAt: string;
}

/** The unit of work on every channel queue: one message, one channel. */
export interface ChannelJob {
  messageId: string;
  tenantId: string;
  channel: Channel;
  subscriberId?: string;
  category: string;
  locale: Locale;
  /** Fully rendered payload — workers never re-render, so they never need the template. */
  payload: unknown;
  /** Resolved destination: email address, phone, device tokens, or webhook url. */
  target: JobTarget;
  attempt: number;
}

export type JobTarget =
  | { kind: 'email'; address: string }
  | { kind: 'sms'; phone: string }
  | { kind: 'push'; tokens: string[] }
  | { kind: 'inapp'; subscriberId: string }
  | { kind: 'webhook'; endpoints: Array<{ endpointId: string; url: string; secret: string }> };

/** What a channel adapter returns. Adapters never throw for expected provider
 *  failures — they return `retryable` so the worker can decide DLQ vs redrive. */
export interface SendOutcome {
  status: 'delivered' | 'failed' | 'suppressed';
  providerMessageId?: string;
  error?: string;
  retryable?: boolean;
  /** Tokens/addresses the provider told us are permanently dead. */
  invalidTargets?: string[];
}
