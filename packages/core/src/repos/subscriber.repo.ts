import { keys, GSI2 } from '../keys';
import { PulseError } from '../errors';
import type { Channel, DeviceToken, Subscriber, SubscriberPreferences } from '../types';
import { BaseRepo, type StoredItem } from './base';

interface SubscriberItem extends StoredItem {
  entity: 'subscriber';
  tenantId: string;
  subscriberId: string;
  email?: string;
  phone?: string;
  locale: Subscriber['locale'];
  timezone: string;
  externalId?: string;
  attributes: Record<string, unknown>;
  preferences: SubscriberPreferences;
  topics: string[];
  createdAt: string;
  updatedAt: string;
  gsi2pk?: string;
  gsi2sk?: string;
}

interface DeviceItem extends StoredItem {
  entity: 'device';
  tenantId: string;
  subscriberId: string;
  token: string;
  platform: DeviceToken['platform'];
  appVersion?: string;
  createdAt: string;
  lastSeenAt: string;
}

export class SubscriberRepo extends BaseRepo {
  async get(tenantId: string, subscriberId: string): Promise<Subscriber | undefined> {
    const item = (await this.getRaw(keys.subscriber(tenantId, subscriberId))) as
      | SubscriberItem
      | undefined;
    return item ? toSubscriber(item) : undefined;
  }

  async getOrThrow(tenantId: string, subscriberId: string): Promise<Subscriber> {
    const s = await this.get(tenantId, subscriberId);
    if (!s) throw new PulseError('SUBSCRIBER_NOT_FOUND', `no subscriber ${subscriberId}`);
    return s;
  }

  /** Resolve by the tenant's own user id, so callers never store Pulse ids. */
  async findByExternalId(tenantId: string, externalId: string): Promise<Subscriber | undefined> {
    const page = await this.queryIndex<SubscriberItem>(
      GSI2,
      'gsi2pk',
      keys.gsi2SubscriberPk(tenantId),
      { limit: 25 },
    );
    const match = page.items.find((i) => i.externalId === externalId);
    return match ? toSubscriber(match) : undefined;
  }

  async put(sub: Subscriber): Promise<Subscriber> {
    const k = keys.subscriber(sub.tenantId, sub.subscriberId);
    const gsi2 = sub.externalId
      ? keys.gsi2Subscriber(sub.tenantId, sub.externalId)
      : { gsi2pk: undefined, gsi2sk: undefined };
    await this.putRaw({
      pk: k.pk,
      sk: k.sk,
      entity: 'subscriber',
      ...sub,
      ...gsi2,
    });
    return sub;
  }

  /** Every subscriber for a tenant. */
  async listAll(tenantId: string): Promise<Subscriber[]> {
    // The `SUB#` prefix also matches device rows (`SUB#<id>#DEV#<token>`), so
    // filter on `entity` rather than trusting the key shape alone.
    const rows = await this.queryAll<SubscriberItem>(keys.tenant(tenantId).pk, 'SUB#');
    return rows.filter((r) => r.entity === 'subscriber').map(toSubscriber);
  }

  /**
   * Subscribers on a topic.
   *
   * V1 filters in memory over the tenant's subscriber partition. That is fine
   * into the low tens of thousands; past that a topic needs its own index
   * (`TOPIC#<name>` rows) rather than a full partition read. Broadcast is the
   * only caller, and it is already a bounded, admin-initiated action.
   */
  async listByTopic(tenantId: string, topic: string): Promise<Subscriber[]> {
    const all = await this.listAll(tenantId);
    return all.filter((s) => s.topics.includes(topic));
  }

  // --- device tokens ---

  async listDevices(tenantId: string, subscriberId: string): Promise<DeviceToken[]> {
    const { pk, prefix } = keys.devicePrefix(tenantId, subscriberId);
    const rows = await this.queryAll<DeviceItem>(pk, prefix);
    return rows.map(toDevice);
  }

  async addDevice(device: DeviceToken): Promise<DeviceToken> {
    const k = keys.device(device.tenantId, device.subscriberId, device.token);
    await this.putRaw({ pk: k.pk, sk: k.sk, entity: 'device', ...device });
    return device;
  }

  async removeDevice(tenantId: string, subscriberId: string, token: string): Promise<void> {
    await this.deleteRaw(keys.device(tenantId, subscriberId, token));
  }

  /**
   * Drop tokens FCM reported as permanently unregistered. Called by the push
   * worker after a send — leaving dead tokens in place would keep every future
   * push to that subscriber partially failing forever.
   */
  async pruneDevices(tenantId: string, subscriberId: string, tokens: string[]): Promise<void> {
    await Promise.all(tokens.map((t) => this.removeDevice(tenantId, subscriberId, t)));
  }
}

/**
 * Would this subscriber accept a message on this channel in this category?
 *
 * Channel switch and category switch are both opt-out: absent means opted in, so
 * a brand-new subscriber receives everything until they say otherwise.
 */
export function isOptedIn(sub: Subscriber, channel: Channel, category: string): boolean {
  if (sub.preferences.channels[channel] === false) return false;
  if (sub.preferences.categories[category] === false) return false;
  return true;
}

function toSubscriber(i: SubscriberItem): Subscriber {
  return {
    tenantId: i.tenantId,
    subscriberId: i.subscriberId,
    email: i.email,
    phone: i.phone,
    locale: i.locale,
    timezone: i.timezone,
    externalId: i.externalId,
    attributes: i.attributes ?? {},
    preferences: i.preferences ?? { channels: {}, categories: {} },
    topics: i.topics ?? [],
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

function toDevice(i: DeviceItem): DeviceToken {
  return {
    tenantId: i.tenantId,
    subscriberId: i.subscriberId,
    token: i.token,
    platform: i.platform,
    appVersion: i.appVersion,
    createdAt: i.createdAt,
    lastSeenAt: i.lastSeenAt,
  };
}
