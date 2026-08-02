import { Injectable, Logger } from '@nestjs/common';
import {
  PulseError,
  type Channel,
  type Message,
  type SendRequest,
  type Tenant,
  type TemplateBodies,
} from '@pulse/core';
import { PulseService } from '../../core/pulse.service';
import type { SendNotificationDto } from './notifications.dto';

export interface AcceptedMessage {
  messageId: string;
  status: Message['status'];
  channels: Channel[];
  results: Message['results'];
  scheduledFor?: string;
  createdAt: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly pulse: PulseService) {}

  /**
   * Accept a send.
   *
   * Quota is consumed BEFORE dispatch and refunded if dispatch throws, so a
   * failed send never silently eats a tenant's allowance — and a burst cannot
   * slip past the limit while messages are still being rendered.
   */
  async send(tenant: Tenant, dto: SendNotificationDto): Promise<AcceptedMessage> {
    const request: SendRequest = {
      to: dto.to,
      templateKey: dto.templateKey,
      content: dto.content as TemplateBodies | undefined,
      channels: dto.channels,
      locale: dto.locale,
      category: dto.category,
      data: dto.data,
      sendAt: dto.sendAt,
    };

    await this.pulse.repos.usage.consumeQuota(tenant.tenantId, tenant.monthlyQuota);

    try {
      const result = await this.pulse.dispatcher.send(tenant, request);

      // Best-effort analytics, recorded only now that the template and the
      // subscriber's preferences have settled which channels actually apply.
      // Never allowed to fail a send that already succeeded.
      void this.pulse.repos.usage
        .recordChannels(tenant.tenantId, result.message.channels)
        .catch((e: unknown) => this.logger.debug(`channel usage stamp failed: ${String(e)}`));

      if (result.scheduledBeyondSqsWindow) {
        // Beyond the 15-minute SQS delay cap. The message row is persisted as
        // `scheduled`; the EventBridge sweeper enqueues it when it comes due.
        this.logger.log(
          `message ${result.message.messageId} scheduled for ${result.message.scheduledFor} (beyond SQS window)`,
        );
      }

      return toAccepted(result.message);
    } catch (e) {
      await this.pulse.repos.usage.refund(tenant.tenantId).catch(() => undefined);
      throw e;
    }
  }

  async get(tenant: Tenant, messageId: string): Promise<Message & { attempts: unknown[] }> {
    const message = await this.pulse.repos.messages.getForTenant(tenant.tenantId, messageId);
    const attempts = await this.pulse.repos.messages.listAttempts(messageId);
    return { ...message, attempts };
  }

  async cancel(tenant: Tenant, messageId: string): Promise<AcceptedMessage> {
    const cancelled = await this.pulse.repos.messages.cancel(tenant.tenantId, messageId);
    return toAccepted(cancelled);
  }

  async list(tenant: Tenant, limit?: number, cursor?: string) {
    return this.pulse.repos.messages.listByTenant(tenant.tenantId, { limit, cursor });
  }

  /**
   * Fan a template out to every subscriber on a topic.
   *
   * Deliberately capped and sequential-ish: a broadcast is the one endpoint that
   * can turn a single request into unbounded work, so it walks the subscriber
   * list in batches rather than materialising it all and firing at once.
   */
  async broadcast(
    tenant: Tenant,
    topic: string,
    dto: { templateKey: string; channels?: Channel[]; locale?: Message['locale']; data?: Record<string, unknown> },
  ): Promise<{ topic: string; accepted: number; messageIds: string[] }> {
    const subscribers = await this.pulse.repos.subscribers.listByTopic(tenant.tenantId, topic);
    if (subscribers.length === 0) {
      throw new PulseError('SUBSCRIBER_NOT_FOUND', `no subscribers on topic '${topic}'`);
    }

    const messageIds: string[] = [];
    const BATCH = 20;

    for (let i = 0; i < subscribers.length; i += BATCH) {
      const batch = subscribers.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (sub) => {
          await this.pulse.repos.usage.consumeQuota(tenant.tenantId, tenant.monthlyQuota);
          return this.pulse.dispatcher.send(tenant, {
            to: { subscriberId: sub.subscriberId },
            templateKey: dto.templateKey,
            channels: dto.channels,
            locale: dto.locale,
            data: dto.data,
          });
        }),
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          messageIds.push(r.value.message.messageId);
        } else {
          // One bad subscriber must not abort the whole broadcast.
          this.logger.warn(`broadcast to topic ${topic} skipped a subscriber: ${String(r.reason)}`);
        }
      }
    }

    return { topic, accepted: messageIds.length, messageIds };
  }
}

function toAccepted(message: Message): AcceptedMessage {
  return {
    messageId: message.messageId,
    status: message.status,
    channels: message.channels,
    results: message.results,
    scheduledFor: message.scheduledFor,
    createdAt: message.createdAt,
  };
}
