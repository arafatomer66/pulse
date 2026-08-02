import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { TableKey } from '../keys';

/**
 * Shared DynamoDB access helpers.
 *
 * Every stored item carries `entity` so a single-table scan (ops, backfills) can
 * tell rows apart without parsing key strings.
 */

export interface StoredItem {
  pk: string;
  sk: string;
  entity: string;
  [attr: string]: unknown;
}

export interface PageOptions {
  limit?: number;
  /** Opaque cursor — a base64 of the DynamoDB LastEvaluatedKey. */
  cursor?: string;
  /** Default true: range keys are time-ordered, and callers almost always want newest first. */
  descending?: boolean;
}

export interface Page<T> {
  items: T[];
  cursor?: string;
}

export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : undefined;
}

export function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    // A malformed cursor restarts the page rather than 500-ing the caller.
    return undefined;
  }
}

export abstract class BaseRepo {
  constructor(
    protected readonly doc: DynamoDBDocumentClient,
    protected readonly table: string,
  ) {}

  protected async getRaw(key: TableKey): Promise<StoredItem | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: key.pk, sk: key.sk } }),
    );
    return res.Item as StoredItem | undefined;
  }

  protected async putRaw(item: StoredItem, condition?: string): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
        ...(condition ? { ConditionExpression: condition } : {}),
      }),
    );
  }

  protected async deleteRaw(key: TableKey): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: key.pk, sk: key.sk } }),
    );
  }

  /** Query one partition for items whose sort key starts with `prefix`. */
  protected async queryPrefix<T>(
    pk: string,
    prefix: string,
    opts: PageOptions = {},
  ): Promise<Page<T>> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
        ScanIndexForward: opts.descending === false,
        ...(opts.limit ? { Limit: opts.limit } : {}),
        ...(decodeCursor(opts.cursor) ? { ExclusiveStartKey: decodeCursor(opts.cursor) } : {}),
      }),
    );
    return {
      items: (res.Items ?? []) as T[],
      cursor: encodeCursor(res.LastEvaluatedKey),
    };
  }

  /** Query a secondary index by its partition key. */
  protected async queryIndex<T>(
    indexName: string,
    pkAttr: string,
    pkValue: string,
    opts: PageOptions = {},
  ): Promise<Page<T>> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: indexName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': pkAttr },
        ExpressionAttributeValues: { ':pk': pkValue },
        ScanIndexForward: opts.descending === false,
        ...(opts.limit ? { Limit: opts.limit } : {}),
        ...(decodeCursor(opts.cursor) ? { ExclusiveStartKey: decodeCursor(opts.cursor) } : {}),
      }),
    );
    return {
      items: (res.Items ?? []) as T[],
      cursor: encodeCursor(res.LastEvaluatedKey),
    };
  }

  /** Drain every page of a prefix query. Only for bounded sets (device tokens,
   *  webhook endpoints) — never for the message log. */
  protected async queryAll<T>(pk: string, prefix: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.queryPrefix<T>(pk, prefix, { cursor, descending: false });
      out.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return out;
  }
}

/** True when DynamoDB rejected a write because our condition did not hold. */
export function isConditionFailed(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    (e as { name: string }).name === 'ConditionalCheckFailedException'
  );
}
