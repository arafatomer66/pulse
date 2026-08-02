import {
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message as SqsMessage,
} from '@aws-sdk/client-sqs';
import { CHANNELS, createContext, loadConfig, queueUrl, waitForSqs, type Channel } from '@pulse/core';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { createChannelHandler } from './handler';

/**
 * Local worker runner.
 *
 * Polls ElasticMQ and invokes the REAL Lambda handlers in-process, building the
 * same SQSEvent shape AWS would. That matters: it means the local e2e suite
 * exercises the production code path including partial batch failure handling,
 * rather than a dev-only shortcut that could drift from what deploys.
 */

const cfg = loadConfig();
const ctx = createContext(cfg);

const sqs = new SQSClient({
  region: cfg.region,
  ...(cfg.sqsEndpoint ? { endpoint: cfg.sqsEndpoint } : {}),
  ...(cfg.sqsEndpoint ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
});

const handlers = Object.fromEntries(
  CHANNELS.map((channel) => [channel, createChannelHandler(channel)]),
) as Record<Channel, ReturnType<typeof createChannelHandler>>;

let running = true;

async function pollChannel(channel: Channel): Promise<void> {
  const url = queueUrl(cfg, channel);

  while (running) {
    let messages: SqsMessage[] = [];
    try {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 30,
          MessageAttributeNames: ['All'],
          // ApproximateReceiveCount is the attempt number the handler uses to
          // decide retry-vs-give-up, so it must be requested explicitly.
          // (`AttributeNames` is deprecated in favour of this in SDK v3.)
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
        }),
      );
      messages = res.Messages ?? [];
    } catch (e) {
      console.error(`[${channel}] receive failed:`, e instanceof Error ? e.message : e);
      await sleep(1_000);
      continue;
    }

    if (messages.length === 0) continue;

    const event: SQSEvent = { Records: messages.map((m) => toRecord(channel, m)) };

    try {
      const result = (await handlers[channel](event, {} as never, () => undefined)) as
        | { batchItemFailures: Array<{ itemIdentifier: string }> }
        | undefined;

      const failed = new Set((result?.batchItemFailures ?? []).map((f) => f.itemIdentifier));

      for (const message of messages) {
        if (!message.MessageId || !message.ReceiptHandle) continue;

        if (failed.has(message.MessageId)) {
          // Make it visible again immediately rather than waiting out the
          // visibility timeout — ElasticMQ then applies maxReceiveCount and
          // moves it to the DLQ on the third failure, exactly as SQS does.
          await sqs
            .send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: url,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: 0,
              }),
            )
            .catch(() => undefined);
          continue;
        }

        await sqs
          .send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }))
          .catch(() => undefined);
      }
    } catch (e) {
      console.error(`[${channel}] handler threw:`, e);
      // Left un-deleted, so the visibility timeout redelivers them.
    }
  }
}

function toRecord(channel: Channel, m: SqsMessage): SQSRecord {
  return {
    messageId: m.MessageId ?? '',
    receiptHandle: m.ReceiptHandle ?? '',
    body: m.Body ?? '',
    attributes: {
      ApproximateReceiveCount: m.Attributes?.ApproximateReceiveCount ?? '1',
      SentTimestamp: m.Attributes?.SentTimestamp ?? `${Date.now()}`,
      SenderId: 'local',
      ApproximateFirstReceiveTimestamp: `${Date.now()}`,
    },
    messageAttributes: {},
    md5OfBody: m.MD5OfBody ?? '',
    eventSource: 'aws:sqs',
    eventSourceARN: `arn:aws:sqs:${cfg.region}:000000000000:pulse-${channel}`,
    awsRegion: cfg.region,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  await waitForSqs(cfg);
  console.log(
    `pulse workers polling ${CHANNELS.join(', ')} at ${cfg.sqsEndpoint ?? 'AWS'}\n` +
      `  email=${cfg.emailProvider} push=${cfg.pushProvider} sms=${cfg.smsProvider}`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} — draining`);
      running = false;
    });
  }

  await Promise.all(CHANNELS.map((channel) => pollChannel(channel)));
  ctx.doc.destroy();
  sqs.destroy();
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
