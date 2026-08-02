import { keys } from '../keys';
import type { Channel, SuppressionEntry } from '../types';
import { BaseRepo, type StoredItem } from './base';

interface SuppressionRow extends StoredItem {
  entity: 'suppression';
  tenantId: string;
  channel: Channel;
  address: string;
  reason: SuppressionEntry['reason'];
  detail?: string;
  createdAt: string;
}

/**
 * The suppression list is what protects SES sender reputation: once an address
 * hard-bounces or files a complaint, every later send to it is skipped without
 * touching the provider. AWS will throttle or block an account that keeps
 * mailing known-bad addresses, so this check is not optional.
 */
export class SuppressionRepo extends BaseRepo {
  async isSuppressed(tenantId: string, channel: Channel, address: string): Promise<boolean> {
    const row = await this.getRaw(keys.suppression(tenantId, channel, normalise(channel, address)));
    return row !== undefined;
  }

  async get(
    tenantId: string,
    channel: Channel,
    address: string,
  ): Promise<SuppressionEntry | undefined> {
    const row = (await this.getRaw(
      keys.suppression(tenantId, channel, normalise(channel, address)),
    )) as SuppressionRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  async add(entry: SuppressionEntry): Promise<SuppressionEntry> {
    const address = normalise(entry.channel, entry.address);
    const k = keys.suppression(entry.tenantId, entry.channel, address);
    await this.putRaw({ pk: k.pk, sk: k.sk, entity: 'suppression', ...entry, address });
    return { ...entry, address };
  }

  /** Manual un-suppress, e.g. a user fixed their mailbox and asked to resubscribe. */
  async remove(tenantId: string, channel: Channel, address: string): Promise<void> {
    await this.deleteRaw(keys.suppression(tenantId, channel, normalise(channel, address)));
  }

  async list(tenantId: string, channel?: Channel): Promise<SuppressionEntry[]> {
    const prefix = channel ? `SUPP#${channel}#` : 'SUPP#';
    const rows = await this.queryAll<SuppressionRow>(keys.tenant(tenantId).pk, prefix);
    return rows.map(toEntry);
  }
}

/**
 * Email addresses are case-insensitive in practice, so `User@x.com` and
 * `user@x.com` must hit the same suppression row. Phone numbers and tokens are
 * left byte-exact.
 */
function normalise(channel: Channel, address: string): string {
  return channel === 'email' ? address.trim().toLowerCase() : address.trim();
}

function toEntry(r: SuppressionRow): SuppressionEntry {
  return {
    tenantId: r.tenantId,
    channel: r.channel,
    address: r.address,
    reason: r.reason,
    detail: r.detail,
    createdAt: r.createdAt,
  };
}
