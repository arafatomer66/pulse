/**
 * Single-table key scheme for `pulse-main`.
 *
 * Every key is built here — no string concatenation of `TENANT#...` anywhere
 * else in the codebase. That keeps the access patterns auditable in one file and
 * makes a key-shape change a single-file edit.
 *
 * Access patterns:
 *   1. auth a request                → GetItem  PK=APIKEY#<sha256>
 *   2. load tenant                   → GetItem  PK=TENANT#<id>  SK=META
 *   3. latest template by key        → Query    PK=TENANT#<id>  SK begins TMPL#<key>#  desc, limit 1
 *   4. subscriber by id              → GetItem  PK=TENANT#<id>  SK=SUB#<id>
 *   5. subscriber by externalId      → Query    GSI2
 *   6. device tokens of a subscriber → Query    PK=TENANT#<id>  SK begins SUB#<id>#DEV#
 *   7. message + its attempts        → Query    PK=MSG#<id>
 *   8. delivery log, newest first    → Query    GSI1 PK=TENANT#<id>#MSG  desc
 *   9. inbox feed                    → Query    PK=TENANT#<id>#SUB#<id>  SK begins INBOX#  desc
 *  10. is address suppressed         → GetItem  PK=TENANT#<id>  SK=SUPP#<ch>#<addr>
 *  11. idempotency claim             → PutItem  PK=IDEM#<tenant>#<key>  attribute_not_exists
 *  12. quota / rate counters         → UpdateItem ADD  PK=TENANT#<id>  SK=USAGE#<period>
 *  13. webhook endpoints             → Query    PK=TENANT#<id>  SK begins HOOK#
 */

export const GSI1 = 'gsi1' as const;
export const GSI2 = 'gsi2' as const;
export const GSI3 = 'gsi3' as const;

export interface TableKey {
  pk: string;
  sk: string;
}

const tenantPk = (tenantId: string) => `TENANT#${tenantId}`;

export const keys = {
  tenant: (tenantId: string): TableKey => ({ pk: tenantPk(tenantId), sk: 'META' }),

  apiKey: (keyHash: string): TableKey => ({ pk: `APIKEY#${keyHash}`, sk: 'META' }),

  template: (tenantId: string, key: string, version: number): TableKey => ({
    pk: tenantPk(tenantId),
    // Zero-padded so lexical sort equals numeric sort — a v10 template must not
    // sort before v9 when we query "latest version, descending".
    sk: `TMPL#${key}#${String(version).padStart(6, '0')}`,
  }),
  templatePrefix: (tenantId: string, key: string) => ({
    pk: tenantPk(tenantId),
    prefix: `TMPL#${key}#`,
  }),

  subscriber: (tenantId: string, subscriberId: string): TableKey => ({
    pk: tenantPk(tenantId),
    sk: `SUB#${subscriberId}`,
  }),

  device: (tenantId: string, subscriberId: string, token: string): TableKey => ({
    pk: tenantPk(tenantId),
    sk: `SUB#${subscriberId}#DEV#${token}`,
  }),
  devicePrefix: (tenantId: string, subscriberId: string) => ({
    pk: tenantPk(tenantId),
    prefix: `SUB#${subscriberId}#DEV#`,
  }),

  message: (messageId: string): TableKey => ({ pk: `MSG#${messageId}`, sk: 'META' }),
  attempt: (messageId: string, at: string, channel: string): TableKey => ({
    pk: `MSG#${messageId}`,
    sk: `ATT#${at}#${channel}`,
  }),
  attemptPrefix: (messageId: string) => ({ pk: `MSG#${messageId}`, prefix: 'ATT#' }),

  inbox: (tenantId: string, subscriberId: string, itemId: string): TableKey => ({
    pk: `TENANT#${tenantId}#SUB#${subscriberId}`,
    sk: `INBOX#${itemId}`,
  }),
  inboxPrefix: (tenantId: string, subscriberId: string) => ({
    pk: `TENANT#${tenantId}#SUB#${subscriberId}`,
    prefix: 'INBOX#',
  }),

  suppression: (tenantId: string, channel: string, address: string): TableKey => ({
    pk: tenantPk(tenantId),
    // Addresses are case-insensitive for email; callers normalise before hashing.
    sk: `SUPP#${channel}#${address}`,
  }),

  idempotency: (tenantId: string, key: string): TableKey => ({
    pk: `IDEM#${tenantId}#${key}`,
    sk: 'META',
  }),

  usage: (tenantId: string, period: string): TableKey => ({
    pk: tenantPk(tenantId),
    sk: `USAGE#${period}`,
  }),

  webhook: (tenantId: string, endpointId: string): TableKey => ({
    pk: tenantPk(tenantId),
    sk: `HOOK#${endpointId}`,
  }),
  webhookPrefix: (tenantId: string) => ({ pk: tenantPk(tenantId), prefix: 'HOOK#' }),

  // --- secondary indexes ---

  /** GSI1: tenant's delivery log, newest first. */
  gsi1Message: (tenantId: string, createdAt: string, messageId: string) => ({
    gsi1pk: `TENANT#${tenantId}#MSG`,
    gsi1sk: `${createdAt}#${messageId}`,
  }),
  gsi1MessagePk: (tenantId: string) => `TENANT#${tenantId}#MSG`,

  /** GSI2: subscriber lookup by the tenant's own user id. */
  gsi2Subscriber: (tenantId: string, externalId: string) => ({
    gsi2pk: `TENANT#${tenantId}#EXT`,
    gsi2sk: externalId,
  }),
  gsi2SubscriberPk: (tenantId: string) => `TENANT#${tenantId}#EXT`,

  /**
   * GSI3: the scheduled-message due queue.
   *
   * Sparse and cross-tenant by design — only messages with a `scheduledFor`
   * beyond the 15-minute SQS delay cap write these attributes, and the sweeper
   * needs one query to find everything due rather than one per tenant. The
   * attributes are removed once the message is enqueued, so the index holds
   * only pending work.
   */
  gsi3Scheduled: (scheduledFor: string, messageId: string) => ({
    gsi3pk: 'SCHEDULED',
    gsi3sk: `${scheduledFor}#${messageId}`,
  }),
  GSI3_SCHEDULED_PK: 'SCHEDULED',
};

/** Monthly usage period key, e.g. `2026-08`. */
export function monthPeriod(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Per-minute rate-limit bucket, e.g. `RATE#2026-08-02T14:03`. */
export function minutePeriod(d = new Date()): string {
  return `RATE#${d.toISOString().slice(0, 16)}`;
}
