import { createHash } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '../keys';
import { PulseError } from '../errors';
import { ttlSecondsFromHours } from '../ids';
import { BaseRepo, isConditionFailed, type StoredItem } from './base';

interface IdempotencyRow extends StoredItem {
  entity: 'idempotency';
  tenantId: string;
  idempotencyKey: string;
  requestHash: string;
  state: 'in_flight' | 'completed';
  response?: unknown;
  statusCode?: number;
  createdAt: string;
  expiresAt: number;
}

export type ClaimResult =
  | { outcome: 'claimed' }
  | { outcome: 'replay'; response: unknown; statusCode: number }
  /** Same key seen again while the first request is still running. */
  | { outcome: 'in_flight' };

/**
 * Claim-first idempotency, ported from sharedeal-social's Postgres
 * `idempotency_keys` interceptor to a DynamoDB conditional put.
 *
 * The claim is written BEFORE the handler runs, so two concurrent retries of the
 * same request cannot both proceed to send. On handler failure the claim is
 * released, letting the client retry a genuinely failed call.
 */
export class IdempotencyRepo extends BaseRepo {
  /** Records expire after 24h — long enough to cover any sane client retry. */
  private readonly ttlHours = 24;

  async claim(tenantId: string, idempotencyKey: string, requestBody: unknown): Promise<ClaimResult> {
    const requestHash = hashRequest(requestBody);
    const k = keys.idempotency(tenantId, idempotencyKey);
    const row: IdempotencyRow = {
      pk: k.pk,
      sk: k.sk,
      entity: 'idempotency',
      tenantId,
      idempotencyKey,
      requestHash,
      state: 'in_flight',
      createdAt: new Date().toISOString(),
      expiresAt: ttlSecondsFromHours(this.ttlHours),
    };

    try {
      await this.putRaw(row, 'attribute_not_exists(pk)');
      return { outcome: 'claimed' };
    } catch (e) {
      if (!isConditionFailed(e)) throw e;
    }

    const existing = (await this.getRaw(k)) as IdempotencyRow | undefined;
    if (!existing) {
      // The claim expired between our failed put and this read. Treat as fresh.
      return { outcome: 'claimed' };
    }

    // Reusing one key for a different payload is a client bug, not a retry —
    // replaying the old response would silently drop the new request.
    if (existing.requestHash !== requestHash) {
      throw new PulseError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used with a different request body',
      );
    }

    if (existing.state === 'completed') {
      return {
        outcome: 'replay',
        response: existing.response,
        statusCode: existing.statusCode ?? 200,
      };
    }
    return { outcome: 'in_flight' };
  }

  async complete(
    tenantId: string,
    idempotencyKey: string,
    response: unknown,
    statusCode = 202,
  ): Promise<void> {
    const k = keys.idempotency(tenantId, idempotencyKey);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: k.pk, sk: k.sk },
        UpdateExpression: 'SET #state = :done, #resp = :r, statusCode = :sc',
        ExpressionAttributeNames: { '#state': 'state', '#resp': 'response' },
        ExpressionAttributeValues: { ':done': 'completed', ':r': response, ':sc': statusCode },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  }

  /** Release a claim whose handler failed, so the client can retry. */
  async release(tenantId: string, idempotencyKey: string): Promise<void> {
    await this.deleteRaw(keys.idempotency(tenantId, idempotencyKey));
  }
}

/** Stable hash of the request body — key order must not change the digest. */
export function hashRequest(body: unknown): string {
  return createHash('sha256').update(stableStringify(body), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
