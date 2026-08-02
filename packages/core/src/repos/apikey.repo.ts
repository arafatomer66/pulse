import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '../keys';
import { hashApiKey } from '../ids';
import type { ApiKeyRecord, Scope } from '../types';
import { BaseRepo, type StoredItem } from './base';

interface ApiKeyItem extends StoredItem {
  entity: 'apikey';
  keyHash: string;
  keyId: string;
  tenantId: string;
  name: string;
  prefix: 'pk_live' | 'pk_test';
  last4: string;
  scopes: Scope[];
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * API keys are stored under their sha256 only. Lookup is a single GetItem on the
 * hash, so authenticating a request costs one strongly-consistent read and never
 * scans. The plaintext exists exactly once, in the create response.
 */
export class ApiKeyRepo extends BaseRepo {
  /** Authenticate: hash the presented key and fetch it. */
  async findByPlaintext(plaintext: string): Promise<ApiKeyRecord | undefined> {
    return this.findByHash(hashApiKey(plaintext));
  }

  async findByHash(keyHash: string): Promise<ApiKeyRecord | undefined> {
    const item = (await this.getRaw(keys.apiKey(keyHash))) as ApiKeyItem | undefined;
    return item ? toRecord(item) : undefined;
  }

  async create(record: ApiKeyRecord): Promise<ApiKeyRecord> {
    const key = keys.apiKey(record.keyHash);
    await this.putRaw({ pk: key.pk, sk: key.sk, entity: 'apikey', ...record });
    return record;
  }

  async revoke(keyHash: string): Promise<void> {
    const key = keys.apiKey(keyHash);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: key.pk, sk: key.sk },
        UpdateExpression: 'SET #status = :revoked',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':revoked': 'revoked' },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  }

  /**
   * Best-effort last-used stamp. Deliberately fire-and-forget at the call site:
   * a failed telemetry write must never fail an authenticated request, and we
   * accept minute-level staleness rather than paying a write on every call.
   */
  async touch(keyHash: string, at = new Date().toISOString()): Promise<void> {
    const key = keys.apiKey(keyHash);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: key.pk, sk: key.sk },
        UpdateExpression: 'SET lastUsedAt = :at',
        ExpressionAttributeValues: { ':at': at },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  }
}

function toRecord(i: ApiKeyItem): ApiKeyRecord {
  return {
    keyHash: i.keyHash,
    keyId: i.keyId,
    tenantId: i.tenantId,
    name: i.name,
    prefix: i.prefix,
    last4: i.last4,
    scopes: i.scopes,
    status: i.status,
    createdAt: i.createdAt,
    lastUsedAt: i.lastUsedAt,
  };
}
