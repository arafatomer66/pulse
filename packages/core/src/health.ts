import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { PulseConfig } from './config';

/**
 * Dependency health probes.
 *
 * Lives in core so the API never imports the AWS SDK directly — every AWS call
 * in the system goes through this package, which keeps credentials, endpoint
 * overrides and timeouts configured in exactly one place.
 */

export interface DependencyHealth {
  ok: boolean;
  detail: string;
  latencyMs: number;
}

/**
 * DescribeTable rather than ListTables: it proves the specific table this
 * process is configured to use exists and is readable, which is what a
 * readiness check actually needs to know.
 *
 * The short request timeout matters — DynamoDB can accept a connection and then
 * hang, and a health check that hangs is worse than one that fails.
 */
export async function checkDynamo(cfg: PulseConfig): Promise<DependencyHealth> {
  const started = Date.now();
  const client = new DynamoDBClient({
    region: cfg.region,
    ...(cfg.dynamodbEndpoint ? { endpoint: cfg.dynamodbEndpoint } : {}),
    ...(cfg.dynamodbEndpoint
      ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {}),
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 1_000, requestTimeout: 2_000 }),
  });

  try {
    const res = await client.send(new DescribeTableCommand({ TableName: cfg.tableName }));
    const status = res.Table?.TableStatus ?? 'UNKNOWN';
    return {
      ok: status === 'ACTIVE',
      detail: status,
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - started,
    };
  } finally {
    client.destroy();
  }
}
