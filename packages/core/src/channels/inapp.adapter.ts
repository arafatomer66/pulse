import { newId, ttlSeconds } from '../ids';
import type { InboxRepo } from '../repos/inbox.repo';
import type { ChannelJob, SendOutcome } from '../types';
import type { RenderedInapp } from '../render/renderer';
import { type ChannelAdapter, errorMessage } from './adapter';

/**
 * In-app inbox delivery.
 *
 * The only adapter with no external provider — "sending" is writing the row that
 * the subscriber's app reads back from `GET /v1/inbox`. It still goes through a
 * queue rather than being written inline during the API request so that one slow
 * or failing channel cannot hold up the others, and so every channel shares one
 * retry and attempt-logging path.
 */
export class InappAdapter implements ChannelAdapter {
  readonly name = 'inapp';

  constructor(
    private readonly inbox: InboxRepo,
    private readonly retentionDays: number,
  ) {}

  async send(job: ChannelJob): Promise<SendOutcome> {
    if (job.target.kind !== 'inapp') {
      return { status: 'failed', error: 'inapp adapter got a non-inapp target', retryable: false };
    }
    const payload = job.payload as RenderedInapp;
    const itemId = newId();

    try {
      await this.inbox.add({
        tenantId: job.tenantId,
        subscriberId: job.target.subscriberId,
        itemId,
        messageId: job.messageId,
        title: payload.title,
        body: payload.body,
        deeplink: payload.deeplink,
        category: job.category,
        createdAt: new Date().toISOString(),
        expiresAt: ttlSeconds(this.retentionDays),
      });
      return { status: 'delivered', providerMessageId: itemId };
    } catch (e) {
      // A DynamoDB write failure here is transient (throttle, network) far more
      // often than not, so it is worth a retry before the DLQ.
      return { status: 'failed', error: errorMessage(e), retryable: true };
    }
  }
}
