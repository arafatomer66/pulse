import {
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  CHANNELS,
  createContext,
  loadConfig,
  queueUrl,
  type Channel,
  type PulseConfig,
  type PulseContext,
} from '@pulse/core';
import { createChannelHandler } from '@pulse/workers';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

/**
 * End-to-end harness.
 *
 * Queues are drained by explicitly invoking the REAL Lambda handlers rather
 * than by running the background poller. That is deliberate: the assertions
 * become deterministic (no "sleep and hope"), while still exercising the exact
 * code that deploys — including partial batch failure reporting and the
 * retry/DLQ decision.
 */

export const E2E_TABLE = 'pulse-e2e';
export const MAILHOG_URL = process.env.MAILHOG_URL ?? 'http://localhost:8125';

export function e2eConfig(): PulseConfig {
  return loadConfig({
    ...process.env,
    PULSE_TABLE: E2E_TABLE,
    DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8102',
    SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:9324',
    QUEUE_URL_PREFIX: process.env.QUEUE_URL_PREFIX ?? 'http://localhost:9324/000000000000',
    AWS_REGION: 'ap-south-1',
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: 'no-reply@pulse.test',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1125',
    PUSH_PROVIDER: 'log',
    SMS_PROVIDER: 'log',
  });
}

export function sqsClient(cfg: PulseConfig): SQSClient {
  return new SQSClient({
    region: cfg.region,
    endpoint: cfg.sqsEndpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}

export interface DrainResult {
  processed: number;
  /** Records the handler asked SQS to redeliver. */
  retried: number;
}

/**
 * Receive everything currently on a channel queue and run the handler over it.
 *
 * Failed records get their visibility reset to 0 so ElasticMQ applies
 * maxReceiveCount and moves them to the DLQ on the third failure — the same
 * redrive behaviour SQS gives us in AWS.
 */
export async function drain(
  cfg: PulseConfig,
  sqs: SQSClient,
  channel: Channel,
  rounds = 1,
): Promise<DrainResult> {
  const url = queueUrl(cfg, channel);
  const handler = createChannelHandler(channel);
  let processed = 0;
  let retried = 0;

  for (let round = 0; round < rounds; round++) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) break;

    const event: SQSEvent = {
      Records: messages.map((m) => ({
        messageId: m.MessageId ?? '',
        receiptHandle: m.ReceiptHandle ?? '',
        body: m.Body ?? '',
        attributes: {
          ApproximateReceiveCount: m.Attributes?.ApproximateReceiveCount ?? '1',
          SentTimestamp: `${Date.now()}`,
          SenderId: 'e2e',
          ApproximateFirstReceiveTimestamp: `${Date.now()}`,
        },
        messageAttributes: {},
        md5OfBody: m.MD5OfBody ?? '',
        eventSource: 'aws:sqs',
        eventSourceARN: `arn:aws:sqs:${cfg.region}:000000000000:pulse-${channel}`,
        awsRegion: cfg.region,
      })) as SQSRecord[],
    };

    const result = (await handler(event, {} as never, () => undefined)) as
      | { batchItemFailures: Array<{ itemIdentifier: string }> }
      | undefined;
    const failed = new Set((result?.batchItemFailures ?? []).map((f) => f.itemIdentifier));

    for (const m of messages) {
      processed++;
      if (!m.ReceiptHandle) continue;
      if (m.MessageId && failed.has(m.MessageId)) {
        retried++;
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: url,
            ReceiptHandle: m.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
      } else {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
      }
    }
  }

  return { processed, retried };
}

export async function drainAll(cfg: PulseConfig, sqs: SQSClient): Promise<void> {
  for (const channel of CHANNELS) await drain(cfg, sqs, channel);
}

export async function purgeAllQueues(cfg: PulseConfig, sqs: SQSClient): Promise<void> {
  for (const channel of CHANNELS) {
    for (const url of [queueUrl(cfg, channel), `${queueUrl(cfg, channel)}-dlq`]) {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
    }
  }
}

export async function queueDepth(sqs: SQSClient, url: string): Promise<number> {
  const res = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
  );
  const messages = res.Messages ?? [];
  // Put them straight back so counting does not consume the queue.
  for (const m of messages) {
    if (!m.ReceiptHandle) continue;
    await sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: url,
          ReceiptHandle: m.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      )
      .catch(() => undefined);
  }
  return messages.length;
}

// --- MailHog ------------------------------------------------------------

export interface CapturedEmail {
  to: string;
  subject: string;
  body: string;
  partCount: number;
}

export async function mailhogClear(): Promise<void> {
  await fetch(`${MAILHOG_URL}/api/v1/messages`, { method: 'DELETE' }).catch(() => undefined);
}

export async function mailhogMessages(): Promise<CapturedEmail[]> {
  const res = await fetch(`${MAILHOG_URL}/api/v2/messages`);
  const payload = (await res.json()) as {
    items: Array<{
      Content: { Headers: Record<string, string[]>; Body: string };
      MIME?: { Parts?: Array<{ Body: string }> };
      To: Array<{ Mailbox: string; Domain: string }>;
    }>;
  };

  return payload.items.map((item) => ({
    to: item.To.map((t) => `${t.Mailbox}@${t.Domain}`).join(','),
    subject: decodeHeader(item.Content.Headers.Subject?.[0] ?? ''),
    // Search the raw body plus every MIME part, so an assertion works whether
    // the content landed in the HTML part or the text alternative.
    body: [item.Content.Body, ...(item.MIME?.Parts ?? []).map((p) => p.Body)].join('\n'),
    partCount: item.MIME?.Parts?.length ?? 0,
  }));
}

/**
 * Decode an RFC 2047 encoded-word header (MailHog returns these for non-ASCII
 * subjects).
 *
 * Long headers are split across several encoded-words. Per RFC 2047 §6.2 the
 * whitespace *between* adjacent encoded-words is a fold marker and must be
 * dropped — decoding each word independently and keeping the separator inserts
 * spaces mid-grapheme, which is what mangled the Bengali subject.
 *
 * Base64 splits can also land mid-character, so the words are joined as bytes
 * and decoded once rather than decoded individually and concatenated.
 */
function decodeHeader(value: string): string {
  const collapsed = value.replace(/\?=\s+=\?/g, '?==?');

  return collapsed.replace(/(?:=\?[^?]+\?[Bb]\?[^?]*\?=)+/g, (run) => {
    const chunks = [...run.matchAll(/=\?[^?]+\?[Bb]\?([^?]*)\?=/g)].map((m) => m[1] ?? '');
    // Each word is independently base64-padded, so joining the *strings* would
    // stop decoding at the first '='. Decode each to bytes, concatenate the
    // buffers, then read the whole thing as UTF-8 — that also repairs
    // multi-byte characters split across a word boundary.
    return Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64'))).toString('utf8');
  });
}

/** MIME quoted-printable / base64 bodies, decoded enough to assert on. */
export function decodeBody(body: string): string {
  const base64Only = body.replace(/\s/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(base64Only) && base64Only.length > 40) {
    try {
      return Buffer.from(base64Only, 'base64').toString('utf8');
    } catch {
      /* fall through */
    }
  }
  return body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

// --- webhook receiver ---------------------------------------------------

export interface WebhookHit {
  headers: Record<string, string>;
  body: string;
}

export interface WebhookReceiver {
  url: string;
  hits: WebhookHit[];
  /** Force the next N requests to fail with this status (retry testing). */
  failWith(status: number, times?: number): void;
  close(): Promise<void>;
}

export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const hits: WebhookHit[] = [];
  let failStatus = 0;
  let failRemaining = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }

      if (failRemaining > 0) {
        failRemaining--;
        res.writeHead(failStatus).end('forced failure');
        return;
      }

      hits.push({ headers, body });
      res.writeHead(200).end('ok');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    // 127.0.0.1 has no TLD, which the API's @IsUrl rejects on create. Tests
    // that need an endpoint write it through the repository directly.
    url: `http://127.0.0.1:${port}/hook`,
    hits,
    failWith(status: number, times = 1) {
      failStatus = status;
      failRemaining = times;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function contextFor(cfg: PulseConfig): PulseContext {
  return createContext(cfg);
}
