import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys, GSI1, GSI3 } from '../keys';
import { PulseError } from '../errors';
import { ttlSeconds } from '../ids';
import type { Channel, ChannelResult, DeliveryStatus, Message, MessageStatus } from '../types';
import { BaseRepo, isConditionFailed, type Page, type PageOptions, type StoredItem } from './base';

interface MessageItem extends StoredItem {
  entity: 'message';
  messageId: string;
  tenantId: string;
  subscriberId?: string;
  templateKey?: string;
  category: string;
  locale: Message['locale'];
  channels: Channel[];
  status: MessageStatus;
  rendered: Partial<Record<Channel, unknown>>;
  data: Record<string, unknown>;
  results: Partial<Record<Channel, ChannelResult>>;
  scheduledFor?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  gsi1pk: string;
  gsi1sk: string;
}

interface AttemptItem extends StoredItem {
  entity: 'attempt';
  messageId: string;
  channel: Channel;
  status: DeliveryStatus;
  attempt: number;
  providerMessageId?: string;
  error?: string;
  at: string;
  expiresAt: number;
}

export class MessageRepo extends BaseRepo {
  /**
   * @param deferred true when the send is beyond the SQS delay cap and must be
   *   picked up later by the scheduler sweeper. Only then do we write the GSI3
   *   attributes, which keeps that index holding pending work and nothing else.
   */
  async create(message: Message, deferred = false): Promise<Message> {
    const k = keys.message(message.messageId);
    const gsi1 = keys.gsi1Message(message.tenantId, message.createdAt, message.messageId);
    const gsi3 =
      deferred && message.scheduledFor
        ? keys.gsi3Scheduled(message.scheduledFor, message.messageId)
        : {};
    await this.putRaw({ pk: k.pk, sk: k.sk, entity: 'message', ...message, ...gsi1, ...gsi3 });
    return message;
  }

  /**
   * Scheduled messages that have come due, oldest first.
   *
   * Cross-tenant on purpose: the sweeper needs one query for all pending work,
   * not one per tenant. `<=` on the range key means a sweeper that missed a
   * tick still picks up everything it slept through.
   */
  async listDueScheduled(now = new Date(), limit = 100): Promise<Message[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: GSI3,
        KeyConditionExpression: '#pk = :pk AND #sk <= :now',
        ExpressionAttributeNames: { '#pk': 'gsi3pk', '#sk': 'gsi3sk' },
        ExpressionAttributeValues: {
          ':pk': keys.GSI3_SCHEDULED_PK,
          // The range key is `<iso>#<messageId>`; comparing against the bare
          // timestamp is correct because '#' sorts below every id character.
          ':now': now.toISOString(),
        },
        ScanIndexForward: true,
        Limit: limit,
      }),
    );
    return ((res.Items ?? []) as MessageItem[]).map(toMessage);
  }

  /**
   * Remove a message from the due queue once it has been enqueued.
   *
   * Conditional on the attributes still being present so two sweeper instances
   * racing on the same message cannot both enqueue it — the loser's condition
   * fails and it skips.
   */
  async claimScheduled(messageId: string): Promise<boolean> {
    const k = keys.message(messageId);
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: k.pk, sk: k.sk },
          UpdateExpression: 'REMOVE gsi3pk, gsi3sk SET #status = :queued, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':queued': 'queued', ':now': new Date().toISOString() },
          ConditionExpression: 'attribute_exists(gsi3pk)',
        }),
      );
      return true;
    } catch (e) {
      if (isConditionFailed(e)) return false;
      throw e;
    }
  }

  async get(messageId: string): Promise<Message | undefined> {
    const item = (await this.getRaw(keys.message(messageId))) as MessageItem | undefined;
    return item ? toMessage(item) : undefined;
  }

  /**
   * Tenant-scoped read. `tenantId` comes from the authorizer context, never the
   * request — this check is what stops tenant B reading tenant A's messages by
   * guessing a ULID.
   */
  async getForTenant(tenantId: string, messageId: string): Promise<Message> {
    const m = await this.get(messageId);
    if (!m || m.tenantId !== tenantId) {
      throw new PulseError('MESSAGE_NOT_FOUND', `no message ${messageId}`);
    }
    return m;
  }

  /** Delivery log, newest first, via GSI1. */
  async listByTenant(tenantId: string, opts: PageOptions = {}): Promise<Page<Message>> {
    const page = await this.queryIndex<MessageItem>(GSI1, 'gsi1pk', keys.gsi1MessagePk(tenantId), {
      descending: opts.descending ?? true,
      limit: opts.limit ?? 50,
      cursor: opts.cursor,
    });
    return { items: page.items.map(toMessage), cursor: page.cursor };
  }

  /**
   * Record one channel's outcome and recompute the roll-up status in the same
   * write. Uses a map key so concurrent channel workers never clobber each other.
   */
  async recordResult(messageId: string, result: ChannelResult): Promise<Message> {
    const k = keys.message(messageId);
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: k.pk, sk: k.sk },
        UpdateExpression: 'SET #results.#ch = :r, updatedAt = :now',
        ExpressionAttributeNames: { '#results': 'results', '#ch': result.channel },
        ExpressionAttributeValues: { ':r': result, ':now': new Date().toISOString() },
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    const updated = toMessage(res.Attributes as MessageItem);

    // Second write rather than one expression: the roll-up depends on the other
    // channels' results, which we only know after the first update returns.
    const rollup = rollUpStatus(updated);
    if (rollup !== updated.status) {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: k.pk, sk: k.sk },
          UpdateExpression: 'SET #status = :s, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':s': rollup, ':now': new Date().toISOString() },
        }),
      );
      updated.status = rollup;
    }
    return updated;
  }

  /** Append-only attempt log, one row per delivery try. */
  async recordAttempt(input: {
    messageId: string;
    channel: Channel;
    status: DeliveryStatus;
    attempt: number;
    providerMessageId?: string;
    error?: string;
    retentionDays: number;
  }): Promise<void> {
    const at = new Date().toISOString();
    const k = keys.attempt(input.messageId, at, input.channel);
    const item: AttemptItem = {
      pk: k.pk,
      sk: k.sk,
      entity: 'attempt',
      messageId: input.messageId,
      channel: input.channel,
      status: input.status,
      attempt: input.attempt,
      providerMessageId: input.providerMessageId,
      error: input.error,
      at,
      expiresAt: ttlSeconds(input.retentionDays),
    };
    await this.putRaw(item);
  }

  async listAttempts(messageId: string): Promise<AttemptItem[]> {
    const { pk, prefix } = keys.attemptPrefix(messageId);
    return this.queryAll<AttemptItem>(pk, prefix);
  }

  /**
   * Cancel a scheduled message. Conditional on the current status so a message
   * that started delivering between the read and the write is not cancelled
   * after the fact.
   */
  async cancel(tenantId: string, messageId: string): Promise<Message> {
    const existing = await this.getForTenant(tenantId, messageId);
    if (existing.status !== 'scheduled' && existing.status !== 'queued') {
      throw new PulseError(
        'MESSAGE_NOT_CANCELLABLE',
        `message is ${existing.status}, only scheduled or queued can be cancelled`,
      );
    }
    const k = keys.message(messageId);
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: k.pk, sk: k.sk },
          UpdateExpression: 'SET #status = :cancelled, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':cancelled': 'cancelled',
            ':now': new Date().toISOString(),
            ':scheduled': 'scheduled',
            ':queued': 'queued',
          },
          ConditionExpression: '#status IN (:scheduled, :queued)',
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toMessage(res.Attributes as MessageItem);
    } catch (e) {
      if (isConditionFailed(e)) {
        throw new PulseError('MESSAGE_NOT_CANCELLABLE', 'message started delivering');
      }
      throw e;
    }
  }

  async setStatus(messageId: string, status: MessageStatus): Promise<void> {
    const k = keys.message(messageId);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: k.pk, sk: k.sk },
        UpdateExpression: 'SET #status = :s, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':s': status, ':now': new Date().toISOString() },
      }),
    );
  }
}

/**
 * Collapse per-channel outcomes into one message status.
 *
 * `suppressed` and `skipped` count as settled-not-failed: a message to a
 * subscriber who opted out of every channel is `delivered` as far as the caller
 * is concerned — we did exactly what their preferences asked for.
 */
export function rollUpStatus(m: Message): MessageStatus {
  const results = m.channels.map((c) => m.results[c]);
  if (results.some((r) => r === undefined)) return 'processing';

  const settled = results.filter((r): r is ChannelResult => r !== undefined);
  const succeeded = settled.filter(
    (r) => r.status === 'delivered' || r.status === 'suppressed' || r.status === 'skipped',
  ).length;
  const failed = settled.filter((r) => r.status === 'failed').length;

  if (failed === 0) return 'delivered';
  if (succeeded === 0) return 'failed';
  return 'partial';
}

function toMessage(i: MessageItem): Message {
  return {
    messageId: i.messageId,
    tenantId: i.tenantId,
    subscriberId: i.subscriberId,
    templateKey: i.templateKey,
    category: i.category,
    locale: i.locale,
    channels: i.channels,
    status: i.status,
    rendered: i.rendered ?? {},
    data: i.data ?? {},
    results: i.results ?? {},
    scheduledFor: i.scheduledFor,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    expiresAt: i.expiresAt,
  };
}
