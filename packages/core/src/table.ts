import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { GSI1, GSI2, GSI3 } from './keys';
import type { PulseConfig } from './config';

/**
 * Table definition for local development and tests.
 *
 * In AWS the table is created by CDK (infra/lib/data-stack.ts) — this module
 * exists so `pnpm seed` and the test suite can stand up an identical table
 * against DynamoDB Local. The two definitions must stay in step; the shape here
 * is the reference the CDK stack mirrors.
 */

export const TTL_ATTRIBUTE = 'expiresAt';

function rawClient(cfg: PulseConfig): DynamoDBClient {
  return new DynamoDBClient({
    region: cfg.region,
    ...(cfg.dynamodbEndpoint ? { endpoint: cfg.dynamodbEndpoint } : {}),
    ...(cfg.dynamodbEndpoint
      ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {}),
  });
}

export async function tableExists(cfg: PulseConfig): Promise<boolean> {
  const client = rawClient(cfg);
  try {
    await client.send(new DescribeTableCommand({ TableName: cfg.tableName }));
    return true;
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'name' in e) {
      const name = String((e as { name: unknown }).name);
      if (name === 'ResourceNotFoundException') return false;
    }
    throw e;
  }
}

export async function createTable(cfg: PulseConfig): Promise<void> {
  const client = rawClient(cfg);

  await client.send(
    new CreateTableCommand({
      TableName: cfg.tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
        { AttributeName: 'gsi2pk', AttributeType: 'S' },
        { AttributeName: 'gsi2sk', AttributeType: 'S' },
        { AttributeName: 'gsi3pk', AttributeType: 'S' },
        { AttributeName: 'gsi3sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          // Delivery log: every message for a tenant, newest first.
          IndexName: GSI1,
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          // Subscriber lookup by the tenant's own user id. Sparse: only rows
          // that set gsi2pk (subscribers with an externalId) are indexed, so we
          // are not paying to replicate every message into it.
          IndexName: GSI2,
          KeySchema: [
            { AttributeName: 'gsi2pk', KeyType: 'HASH' },
            { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          // Scheduled-message due queue. Sparse: only messages awaiting a
          // future send carry gsi3pk, and the attributes are stripped once the
          // message is enqueued, so the index stays small no matter how much
          // history the table accumulates.
          IndexName: GSI3,
          KeySchema: [
            { AttributeName: 'gsi3pk', KeyType: 'HASH' },
            { AttributeName: 'gsi3sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: cfg.tableName });

  // DynamoDB Local accepts the TTL call but does not actually reap rows. That is
  // fine — TTL only matters in AWS, and tests assert on expiresAt values rather
  // than on deletion.
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: cfg.tableName,
        TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
      }),
    );
  } catch {
    // Non-fatal: an older DynamoDB Local build may reject it outright.
  }
}

export async function ensureTable(cfg: PulseConfig): Promise<void> {
  if (!(await tableExists(cfg))) await createTable(cfg);
}

/** Tests only — drops the table so a suite can start from empty. */
export async function dropTable(cfg: PulseConfig): Promise<void> {
  if (!(await tableExists(cfg))) return;
  await rawClient(cfg).send(new DeleteTableCommand({ TableName: cfg.tableName }));
}
