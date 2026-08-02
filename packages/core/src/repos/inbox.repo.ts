import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '../keys';
import type { InboxItem } from '../types';
import { BaseRepo, type Page, type PageOptions, type StoredItem } from './base';

interface InboxRow extends StoredItem {
  entity: 'inbox';
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

/**
 * The in-app notification feed. Item ids are ULIDs, so the sort key is already
 * chronological and a descending query is a newest-first feed with no extra
 * index and no sorting in the API.
 */
export class InboxRepo extends BaseRepo {
  async add(item: InboxItem): Promise<InboxItem> {
    const k = keys.inbox(item.tenantId, item.subscriberId, item.itemId);
    await this.putRaw({ pk: k.pk, sk: k.sk, entity: 'inbox', ...item });
    return item;
  }

  async list(
    tenantId: string,
    subscriberId: string,
    opts: PageOptions = {},
  ): Promise<Page<InboxItem>> {
    const { pk, prefix } = keys.inboxPrefix(tenantId, subscriberId);
    const page = await this.queryPrefix<InboxRow>(pk, prefix, {
      descending: opts.descending ?? true,
      limit: opts.limit ?? 50,
      cursor: opts.cursor,
    });
    return { items: page.items.map(toItem), cursor: page.cursor };
  }

  /**
   * Unread count over the most recent window rather than the whole feed: an
   * unbounded count would grow into a multi-page query on every app launch. The
   * cap matches what the UI can meaningfully display as a badge.
   */
  async unreadCount(tenantId: string, subscriberId: string, cap = 200): Promise<number> {
    const page = await this.list(tenantId, subscriberId, { limit: cap });
    return page.items.filter((i) => !i.readAt).length;
  }

  async markRead(
    tenantId: string,
    subscriberId: string,
    itemId: string,
    at = new Date().toISOString(),
  ): Promise<void> {
    const k = keys.inbox(tenantId, subscriberId, itemId);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: k.pk, sk: k.sk },
        UpdateExpression: 'SET readAt = :at',
        ExpressionAttributeValues: { ':at': at },
        // Idempotent: re-reading an already-read item keeps the original stamp.
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(readAt)',
      }),
    );
  }

  async markAllRead(tenantId: string, subscriberId: string): Promise<number> {
    const page = await this.list(tenantId, subscriberId, { limit: 200 });
    const unread = page.items.filter((i) => !i.readAt);
    const at = new Date().toISOString();
    await Promise.all(
      unread.map((i) =>
        this.markRead(tenantId, subscriberId, i.itemId, at).catch(() => undefined),
      ),
    );
    return unread.length;
  }
}

function toItem(i: InboxRow): InboxItem {
  return {
    tenantId: i.tenantId,
    subscriberId: i.subscriberId,
    itemId: i.itemId,
    messageId: i.messageId,
    title: i.title,
    body: i.body,
    deeplink: i.deeplink,
    category: i.category,
    readAt: i.readAt,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
  };
}
