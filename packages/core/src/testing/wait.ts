import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { PulseConfig } from '../config';

/**
 * Readiness polling for the local docker stack.
 *
 * The dynamodb-local image ships neither curl nor wget, so a compose
 * healthcheck cannot probe it — every CMD-SHELL test reports unhealthy. We poll
 * from Node instead, where we already have an HTTP client.
 */

/**
 * Issue a real ListTables call, not a socket check.
 *
 * A TCP probe is not enough: when DynamoDB Local cannot open its SQLite file it
 * still accepts connections and answers 400 to a bare GET, while hanging every
 * actual API call forever. Only a real request distinguishes "listening" from
 * "working", and the per-attempt timeout is what turns that hang into a retry.
 */
export async function waitForDynamo(cfg: PulseConfig, timeoutMs = 30_000): Promise<void> {
  const endpoint = cfg.dynamodbEndpoint;
  if (!endpoint) return; // Real AWS — nothing to wait for.

  const client = new DynamoDBClient({
    region: cfg.region,
    endpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 2_000,
      requestTimeout: 3_000,
    }),
  });

  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }));
      client.destroy();
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(500);
  }

  client.destroy();
  throw new Error(
    `DynamoDB Local did not answer ListTables at ${endpoint} within ${timeoutMs}ms ` +
      `(last: ${lastError}). Is \`docker compose up -d\` running? ` +
      'If it is, check `docker logs pulse-dynamodb` for SQLite permission errors.',
  );
}

export async function waitForSqs(cfg: PulseConfig, timeoutMs = 30_000): Promise<void> {
  const endpoint = cfg.sqsEndpoint;
  if (!endpoint) return;
  await waitForHttp(`${endpoint}/?Action=ListQueues`, timeoutMs, 'ElasticMQ', (s) => s === 200);
}

export async function waitForMailhog(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  await waitForHttp(`${baseUrl}/api/v2/messages`, timeoutMs, 'MailHog', (s) => s === 200);
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  label: string,
  accept: (status: number) => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (accept(res.status)) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(250);
  }

  throw new Error(
    `${label} did not become ready at ${url} within ${timeoutMs}ms (last: ${lastError}). ` +
      'Is `docker compose up -d` running?',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
