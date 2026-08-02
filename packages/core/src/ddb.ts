import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PulseConfig } from './config';

/**
 * DynamoDB document-client factory.
 *
 * One client per process — the SDK keeps a connection pool, and Lambda reuses
 * the module scope across warm invocations, so constructing per request would
 * throw away the handshake on every call.
 */

let cached: DynamoDBDocumentClient | undefined;

export function createDocClient(cfg: PulseConfig): DynamoDBDocumentClient {
  const base = new DynamoDBClient({
    region: cfg.region,
    ...(cfg.dynamodbEndpoint ? { endpoint: cfg.dynamodbEndpoint } : {}),
    // DynamoDB Local rejects nothing, but the signer still needs credentials
    // present. In AWS this branch is skipped and the default chain applies.
    ...(cfg.dynamodbEndpoint
      ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {}),
  });

  return DynamoDBDocumentClient.from(base, {
    marshallOptions: {
      // Attributes we never set are simply absent rather than stored as NULL,
      // which keeps `attribute_not_exists` conditions meaningful.
      removeUndefinedValues: true,
      convertClassInstanceToMap: true,
    },
    unmarshallOptions: { wrapNumbers: false },
  });
}

export function getDocClient(cfg: PulseConfig): DynamoDBDocumentClient {
  cached ??= createDocClient(cfg);
  return cached;
}

/** Tests reset the cached client between suites that use different endpoints. */
export function resetDocClient(): void {
  cached = undefined;
}
