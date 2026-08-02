import { PulseError } from '../errors';
import { newMessageId, ttlSeconds } from '../ids';
import { renderChannel, type RenderedPayload } from '../render/renderer';
import { isOptedIn } from '../repos/subscriber.repo';
import { delayUntil, MAX_SQS_DELAY_SECONDS } from '../queue';
import type { PulseContext } from '../context';
import type {
  Channel,
  ChannelJob,
  ChannelResult,
  JobTarget,
  Locale,
  Message,
  Subscriber,
  Template,
  TemplateBodies,
  Tenant,
} from '../types';

/**
 * The send pipeline: resolve → filter → render → persist → enqueue.
 *
 * Rendering happens HERE, in the API request, not in the workers. That costs a
 * little API latency but buys three things: a template error is reported
 * synchronously as a 422 instead of surfacing minutes later in a DLQ; a
 * template edited mid-flight cannot change what an already-accepted message
 * says; and the workers stay thin enough to keep a ~100ms cold start.
 */

export interface SendRecipient {
  subscriberId?: string;
  externalId?: string;
  /** Ad-hoc destinations for recipients with no stored subscriber. */
  email?: string;
  phone?: string;
}

export interface SendRequest {
  to: SendRecipient;
  templateKey?: string;
  /** Inline bodies, for one-off sends that do not warrant a stored template. */
  content?: TemplateBodies;
  channels?: Channel[];
  locale?: Locale;
  category?: string;
  data?: Record<string, unknown>;
  /** ISO-8601. Must be in the future. */
  sendAt?: string;
}

export interface SendResult {
  message: Message;
  /** Jobs actually enqueued — excludes channels skipped or suppressed up front. */
  enqueued: ChannelJob[];
  /** Set when the send was deferred to EventBridge rather than SQS. */
  scheduledBeyondSqsWindow: boolean;
}

export class Dispatcher {
  constructor(private readonly ctx: PulseContext) {}

  async send(tenant: Tenant, req: SendRequest): Promise<SendResult> {
    const now = new Date();
    const sendAt = req.sendAt ? new Date(req.sendAt) : undefined;
    if (sendAt && Number.isNaN(sendAt.getTime())) {
      throw new PulseError('VALIDATION_FAILED', 'sendAt is not a valid ISO-8601 timestamp');
    }
    // One minute of slack absorbs clock skew between the caller and us; a
    // stricter check would reject "send now" requests from a slightly fast client.
    if (sendAt && sendAt.getTime() < now.getTime() - 60_000) {
      throw new PulseError('SCHEDULE_IN_PAST', 'sendAt is in the past');
    }

    const subscriber = await this.resolveSubscriber(tenant.tenantId, req.to);
    const template = await this.resolveTemplate(tenant.tenantId, req);
    const locale = req.locale ?? subscriber?.locale ?? 'en';
    const category = req.category ?? template.category;
    const data = this.buildData(req.data ?? {}, subscriber);

    const requested = req.channels ?? definedChannels(template, locale);
    if (requested.length === 0) {
      throw new PulseError(
        'NO_DELIVERABLE_CHANNEL',
        'no channels requested and the template defines none',
      );
    }

    const messageId = newMessageId();
    const rendered: Partial<Record<Channel, unknown>> = {};
    const results: Partial<Record<Channel, ChannelResult>> = {};
    const jobs: ChannelJob[] = [];

    for (const channel of requested) {
      const payload = await renderChannel(template, channel, locale, data);
      if (!payload) {
        // The template has nothing for this channel. Degrade rather than fail —
        // asking for push on an email-only template should not 4xx the caller.
        results[channel] = settled(channel, 'skipped', 'template defines no body for this channel');
        continue;
      }

      if (subscriber && !isOptedIn(subscriber, channel, category)) {
        results[channel] = settled(channel, 'suppressed', `subscriber opted out of ${category}`);
        continue;
      }

      const target = await this.resolveTarget(tenant.tenantId, channel, subscriber, req.to);
      if ('skip' in target) {
        results[channel] = settled(channel, target.status, target.skip);
        continue;
      }

      rendered[channel] = payload;
      jobs.push({
        messageId,
        tenantId: tenant.tenantId,
        channel,
        subscriberId: subscriber?.subscriberId,
        category,
        locale,
        payload,
        target: target.target,
        attempt: 0,
      });
    }

    // Every requested channel resolved to "nothing to do". That is a legitimate
    // settled outcome, not an error: the caller asked, preferences said no.
    const deferBeyondSqs =
      sendAt !== undefined && delayUntil(sendAt, now) > MAX_SQS_DELAY_SECONDS;

    const message: Message = {
      messageId,
      tenantId: tenant.tenantId,
      subscriberId: subscriber?.subscriberId,
      templateKey: req.templateKey,
      category,
      locale,
      channels: requested,
      status: jobs.length === 0 ? 'delivered' : sendAt ? 'scheduled' : 'queued',
      rendered,
      data,
      results,
      scheduledFor: sendAt?.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: ttlSeconds(tenant.retentionDays, now),
    };

    await this.ctx.repos.messages.create(message, deferBeyondSqs && jobs.length > 0);

    if (jobs.length > 0 && !deferBeyondSqs) {
      await this.ctx.queue.publishAll(jobs, sendAt ? delayUntil(sendAt, now) : 0);
    }

    return { message, enqueued: deferBeyondSqs ? [] : jobs, scheduledBeyondSqsWindow: deferBeyondSqs };
  }

  /**
   * Enqueue a scheduled message that has come due.
   *
   * Targets and preferences are re-resolved rather than replayed from the
   * original request: between scheduling and sending — potentially days — a
   * subscriber may have unsubscribed, changed address, or been suppressed by a
   * bounce. Honouring the state at send time is both the correct behaviour and,
   * for marketing categories, the legally required one.
   *
   * The rendered content is NOT re-rendered: it was frozen when the message was
   * accepted, so a template edited in the meantime cannot change what an
   * already-accepted message says.
   */
  async resumeScheduled(tenant: Tenant, message: Message): Promise<ChannelJob[]> {
    const subscriber = message.subscriberId
      ? await this.ctx.repos.subscribers.get(tenant.tenantId, message.subscriberId)
      : undefined;

    const jobs: ChannelJob[] = [];

    for (const channel of message.channels) {
      const payload = message.rendered[channel];
      // No frozen payload means this channel was already settled as
      // skipped/suppressed when the message was accepted.
      if (payload === undefined) continue;

      if (subscriber && !isOptedIn(subscriber, channel, message.category)) {
        await this.ctx.repos.messages
          .recordResult(message.messageId, settled(channel, 'suppressed', 'opted out before send'))
          .catch(() => undefined);
        continue;
      }

      const target = await this.resolveTarget(tenant.tenantId, channel, subscriber, {});
      if ('skip' in target) {
        await this.ctx.repos.messages
          .recordResult(message.messageId, settled(channel, target.status, target.skip))
          .catch(() => undefined);
        continue;
      }

      jobs.push({
        messageId: message.messageId,
        tenantId: tenant.tenantId,
        channel,
        subscriberId: subscriber?.subscriberId,
        category: message.category,
        locale: message.locale,
        payload,
        target: target.target,
        attempt: 0,
      });
    }

    if (jobs.length > 0) await this.ctx.queue.publishAll(jobs);
    return jobs;
  }

  // --- resolution helpers ---

  private async resolveSubscriber(
    tenantId: string,
    to: SendRecipient,
  ): Promise<Subscriber | undefined> {
    if (to.subscriberId) {
      return this.ctx.repos.subscribers.getOrThrow(tenantId, to.subscriberId);
    }
    if (to.externalId) {
      const found = await this.ctx.repos.subscribers.findByExternalId(tenantId, to.externalId);
      if (!found) {
        throw new PulseError('SUBSCRIBER_NOT_FOUND', `no subscriber with externalId ${to.externalId}`);
      }
      return found;
    }
    // Ad-hoc send straight to an address — no stored subscriber, so no stored
    // preferences either. Callers using this path own their own opt-out state.
    if (to.email || to.phone) return undefined;

    throw new PulseError(
      'VALIDATION_FAILED',
      'to must carry one of subscriberId, externalId, email or phone',
    );
  }

  private async resolveTemplate(tenantId: string, req: SendRequest): Promise<Template> {
    if (req.templateKey) {
      return this.ctx.repos.templates.getLatestOrThrow(tenantId, req.templateKey);
    }
    if (req.content) {
      // Wrap inline content in an ephemeral template so the render path is
      // identical whether or not a stored template was used.
      return {
        tenantId,
        key: '__inline__',
        version: 0,
        name: 'inline',
        category: req.category ?? 'transactional',
        locales: { en: req.content },
        createdAt: new Date().toISOString(),
      };
    }
    throw new PulseError('VALIDATION_FAILED', 'either templateKey or content is required');
  }

  /**
   * Where does this channel actually deliver to? Returns either a target or a
   * reason the channel is being skipped.
   */
  private async resolveTarget(
    tenantId: string,
    channel: Channel,
    subscriber: Subscriber | undefined,
    to: SendRecipient,
  ): Promise<{ target: JobTarget } | { skip: string; status: 'skipped' | 'suppressed' }> {
    switch (channel) {
      case 'email': {
        const address = subscriber?.email ?? to.email;
        if (!address) return { skip: 'no email address on file', status: 'skipped' };
        if (await this.ctx.repos.suppression.isSuppressed(tenantId, 'email', address)) {
          return { skip: `${address} is on the suppression list`, status: 'suppressed' };
        }
        return { target: { kind: 'email', address } };
      }
      case 'sms': {
        const phone = subscriber?.phone ?? to.phone;
        if (!phone) return { skip: 'no phone number on file', status: 'skipped' };
        if (await this.ctx.repos.suppression.isSuppressed(tenantId, 'sms', phone)) {
          return { skip: `${phone} is on the suppression list`, status: 'suppressed' };
        }
        return { target: { kind: 'sms', phone } };
      }
      case 'push': {
        if (!subscriber) return { skip: 'push requires a stored subscriber', status: 'skipped' };
        const devices = await this.ctx.repos.subscribers.listDevices(
          tenantId,
          subscriber.subscriberId,
        );
        const tokens = devices.map((d) => d.token);
        if (tokens.length === 0) return { skip: 'no registered devices', status: 'skipped' };
        return { target: { kind: 'push', tokens } };
      }
      case 'inapp': {
        if (!subscriber) return { skip: 'inapp requires a stored subscriber', status: 'skipped' };
        return { target: { kind: 'inapp', subscriberId: subscriber.subscriberId } };
      }
      case 'webhook': {
        const endpoints = await this.ctx.repos.webhooks.listForEvent(tenantId, '*');
        if (endpoints.length === 0) {
          return { skip: 'no active webhook endpoints', status: 'skipped' };
        }
        return {
          target: {
            kind: 'webhook',
            endpoints: endpoints.map((e) => ({
              endpointId: e.endpointId,
              url: e.url,
              secret: e.secret,
            })),
          },
        };
      }
    }
  }

  /** Template variables: caller data plus a `subscriber` namespace. */
  private buildData(
    data: Record<string, unknown>,
    subscriber: Subscriber | undefined,
  ): Record<string, unknown> {
    if (!subscriber) return data;
    return {
      ...data,
      subscriber: {
        id: subscriber.subscriberId,
        email: subscriber.email,
        phone: subscriber.phone,
        locale: subscriber.locale,
        ...subscriber.attributes,
      },
    };
  }
}

function settled(channel: Channel, status: 'skipped' | 'suppressed', reason: string): ChannelResult {
  return { channel, status, reason, attempts: 0, updatedAt: new Date().toISOString() };
}

/** Channels a template actually defines a body for, in a stable order. */
export function definedChannels(template: Template, locale: Locale): Channel[] {
  const bodies: TemplateBodies = {
    ...template.locales.en,
    ...(template.locales[locale] ?? {}),
  };
  const order: Channel[] = ['email', 'push', 'sms', 'inapp', 'webhook'];
  return order.filter((c) => bodies[c] !== undefined);
}

export type { RenderedPayload };
