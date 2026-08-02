import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys, minutePeriod, monthPeriod } from '../keys';
import { PulseError } from '../errors';
import { ttlSecondsFromHours } from '../ids';
import type { Channel } from '../types';
import { BaseRepo, isConditionFailed, type StoredItem } from './base';

interface UsageRow extends StoredItem {
  entity: 'usage';
  tenantId: string;
  period: string;
  sent: number;
  byChannel?: Partial<Record<Channel, number>>;
  expiresAt?: number;
}

export interface UsageSnapshot {
  period: string;
  sent: number;
  byChannel: Partial<Record<Channel, number>>;
  quota: number;
  remaining: number;
}

/**
 * Quota and rate limiting via DynamoDB atomic counters.
 *
 * `ADD` is atomic server-side, so concurrent Lambdas increment without a lock.
 * The limit is enforced with a ConditionExpression on the same update, which
 * makes check-and-increment a single round trip — checking first and then
 * incrementing would let a burst slip past the limit between the two calls.
 */
export class UsageRepo extends BaseRepo {
  /**
   * Per-minute token bucket. Throws RATE_LIMITED when the tenant is over.
   * Buckets carry a 2h TTL so spent minutes are reaped automatically.
   */
  async consumeRateToken(tenantId: string, limitPerMin: number, now = new Date()): Promise<void> {
    const k = keys.usage(tenantId, minutePeriod(now));
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: k.pk, sk: k.sk },
          UpdateExpression:
            'SET entity = :e, tenantId = :t, expiresAt = :ttl ADD #count :one',
          ExpressionAttributeNames: { '#count': 'count' },
          ExpressionAttributeValues: {
            ':e': 'ratebucket',
            ':t': tenantId,
            ':ttl': ttlSecondsFromHours(2, now),
            ':one': 1,
            ':limit': limitPerMin,
          },
          // Passes when the attribute is absent (first call this minute) or
          // still below the limit.
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        }),
      );
    } catch (e) {
      if (isConditionFailed(e)) {
        throw new PulseError('RATE_LIMITED', `over ${limitPerMin} requests/minute`);
      }
      throw e;
    }
  }

  /**
   * Claim one unit of monthly quota.
   *
   * One unit per message, not per channel — tenants think in notifications
   * sent, and billing a 3-channel message as three sends would be a surprise.
   *
   * Called BEFORE dispatch, which is why it takes no channel list: which
   * channels a message actually resolves to is only known after the template is
   * loaded and preferences applied. The breakdown is recorded separately by
   * recordChannels() once that is settled.
   */
  async consumeQuota(tenantId: string, quota: number, now = new Date()): Promise<void> {
    const period = monthPeriod(now);
    const k = keys.usage(tenantId, period);

    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: k.pk, sk: k.sk },
          UpdateExpression: 'SET entity = :e, tenantId = :t, period = :p ADD sent :one',
          ExpressionAttributeValues: {
            ':e': 'usage',
            ':t': tenantId,
            ':p': period,
            ':one': 1,
            ':quota': quota,
          },
          ConditionExpression: 'attribute_not_exists(sent) OR sent < :quota',
        }),
      );
    } catch (e) {
      if (isConditionFailed(e)) {
        throw new PulseError('QUOTA_EXCEEDED', `monthly quota of ${quota} messages reached`);
      }
      throw e;
    }
  }

  /**
   * Record which channels a message resolved to, as `channel_email`,
   * `channel_push`, … counters on the same usage row.
   *
   * Analytics, not a limit: unconditional, and callers treat a failure as
   * non-fatal. A lost breakdown must never fail a send that already happened.
   */
  async recordChannels(tenantId: string, channels: Channel[], now = new Date()): Promise<void> {
    if (channels.length === 0) return;

    // Deduplicate: DynamoDB rejects an expression that touches one attribute
    // twice, and a caller passing the same channel twice is not worth a 500.
    const unique = [...new Set(channels)];
    const k = keys.usage(tenantId, monthPeriod(now));

    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: k.pk, sk: k.sk },
        UpdateExpression: `ADD ${unique.map((_, i) => `#ch${i} :one`).join(', ')}`,
        ExpressionAttributeNames: Object.fromEntries(
          unique.map((c, i) => [`#ch${i}`, `channel_${c}`]),
        ),
        ExpressionAttributeValues: { ':one': 1 },
      }),
    );
  }

  async snapshot(tenantId: string, quota: number, now = new Date()): Promise<UsageSnapshot> {
    const period = monthPeriod(now);
    const row = (await this.getRaw(keys.usage(tenantId, period))) as
      | (UsageRow & Record<string, unknown>)
      | undefined;
    const sent = typeof row?.sent === 'number' ? row.sent : 0;

    const byChannel: Partial<Record<Channel, number>> = {};
    for (const [attr, value] of Object.entries(row ?? {})) {
      if (attr.startsWith('channel_') && typeof value === 'number') {
        byChannel[attr.slice('channel_'.length) as Channel] = value;
      }
    }

    return { period, sent, byChannel, quota, remaining: Math.max(0, quota - sent) };
  }

  /**
   * Give a quota unit back when the send failed before anything was queued.
   * Guarded so a double refund can never drive the counter negative; a lost
   * refund is acceptable (the tenant is charged one extra unit), a negative
   * counter is not (it would hand out free quota).
   */
  async refund(tenantId: string, now = new Date()): Promise<void> {
    const k = keys.usage(tenantId, monthPeriod(now));
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: k.pk, sk: k.sk },
          UpdateExpression: 'ADD sent :minusOne',
          ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
          ConditionExpression: 'attribute_exists(sent) AND sent > :zero',
        }),
      );
    } catch (e) {
      if (!isConditionFailed(e)) throw e;
    }
  }
}
