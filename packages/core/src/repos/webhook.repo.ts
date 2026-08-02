import { keys } from '../keys';
import { PulseError } from '../errors';
import type { WebhookEndpoint } from '../types';
import { BaseRepo, type StoredItem } from './base';

interface WebhookRow extends StoredItem {
  entity: 'webhook';
  tenantId: string;
  endpointId: string;
  url: string;
  secret: string;
  events: string[];
  status: 'active' | 'disabled';
  createdAt: string;
}

export class WebhookRepo extends BaseRepo {
  async list(tenantId: string): Promise<WebhookEndpoint[]> {
    const { pk, prefix } = keys.webhookPrefix(tenantId);
    const rows = await this.queryAll<WebhookRow>(pk, prefix);
    return rows.map(toEndpoint);
  }

  /** Active endpoints subscribed to an event, or to `*`. */
  async listForEvent(tenantId: string, event: string): Promise<WebhookEndpoint[]> {
    const all = await this.list(tenantId);
    return all.filter(
      (e) => e.status === 'active' && (e.events.includes('*') || e.events.includes(event)),
    );
  }

  async get(tenantId: string, endpointId: string): Promise<WebhookEndpoint> {
    const row = (await this.getRaw(keys.webhook(tenantId, endpointId))) as WebhookRow | undefined;
    if (!row) throw new PulseError('WEBHOOK_NOT_FOUND', `no webhook endpoint ${endpointId}`);
    return toEndpoint(row);
  }

  async put(endpoint: WebhookEndpoint): Promise<WebhookEndpoint> {
    const k = keys.webhook(endpoint.tenantId, endpoint.endpointId);
    await this.putRaw({ pk: k.pk, sk: k.sk, entity: 'webhook', ...endpoint });
    return endpoint;
  }

  async remove(tenantId: string, endpointId: string): Promise<void> {
    await this.deleteRaw(keys.webhook(tenantId, endpointId));
  }
}

function toEndpoint(r: WebhookRow): WebhookEndpoint {
  return {
    tenantId: r.tenantId,
    endpointId: r.endpointId,
    url: r.url,
    secret: r.secret,
    events: r.events ?? [],
    status: r.status,
    createdAt: r.createdAt,
  };
}
