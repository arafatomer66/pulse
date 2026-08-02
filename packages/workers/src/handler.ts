import { createContext, type Channel, type ChannelJob, type PulseContext } from '@pulse/core';
import type { SQSBatchResponse, SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda';
import { processJob } from './process-job';

/**
 * SQS handler factory.
 *
 * The context is built once in module scope so warm invocations reuse the AWS
 * SDK connection pool. Deliberately no NestJS here: these are the hot path, and
 * a DI container bootstrap would add roughly a second to every cold start for
 * no benefit — the workers need repositories and one adapter, nothing more.
 */

let cached: PulseContext | undefined;

function context(): PulseContext {
  cached ??= createContext();
  return cached;
}

export function createChannelHandler(channel: Channel): SQSHandler {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const ctx = context();

    // Records are processed concurrently: one slow provider call must not
    // serialise the whole batch into a visibility-timeout expiry.
    const settled = await Promise.allSettled(
      event.Records.map((record) => handleRecord(ctx, channel, record)),
    );

    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    settled.forEach((outcome, idx) => {
      const record = event.Records[idx];
      if (!record) return;

      if (outcome.status === 'rejected') {
        // An unexpected throw is treated as retryable — better a duplicate
        // delivery attempt than a silently dropped notification.
        console.error(`[${channel}] ${record.messageId} threw:`, outcome.reason);
        batchItemFailures.push({ itemIdentifier: record.messageId });
        return;
      }
      if (outcome.value.retry) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    });

    // Partial batch response: only the listed records become visible again.
    // Without this, one poison message would redeliver its nine healthy
    // batch-mates alongside it on every retry.
    return { batchItemFailures };
  };
}

async function handleRecord(
  ctx: PulseContext,
  channel: Channel,
  record: SQSRecord,
): Promise<{ retry: boolean }> {
  let job: ChannelJob;
  try {
    job = JSON.parse(record.body) as ChannelJob;
  } catch {
    // Unparseable body will never parse. Retrying it just burns the redrive
    // budget, so ack it and let the log carry the evidence.
    console.error(`[${channel}] ${record.messageId}: body is not valid JSON, dropping`);
    return { retry: false };
  }

  if (job.channel !== channel) {
    console.error(`[${channel}] ${record.messageId}: job is for '${job.channel}', dropping`);
    return { retry: false };
  }

  // SQS counts deliveries from 1, which is exactly the attempt number.
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? '1') || 1;

  const outcome = await processJob(ctx, job, receiveCount);
  return { retry: outcome.retry };
}

export const emailHandler = createChannelHandler('email');
export const pushHandler = createChannelHandler('push');
export const smsHandler = createChannelHandler('sms');
export const inappHandler = createChannelHandler('inapp');
export const webhookHandler = createChannelHandler('webhook');
