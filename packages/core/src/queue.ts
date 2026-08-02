import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { queueUrl, type PulseConfig } from './config';
import type { Channel, ChannelJob } from './types';

/**
 * SQS publisher.
 *
 * SQS caps DelaySeconds at 15 minutes. Anything further out is handed to
 * EventBridge Scheduler instead (see scheduler.ts), which enqueues the job when
 * it comes due — so this module never needs to know about long delays.
 */
export const MAX_SQS_DELAY_SECONDS = 900;

export class QueuePublisher {
  private client: SQSClient;

  constructor(private readonly cfg: PulseConfig) {
    this.client = new SQSClient({
      region: cfg.region,
      ...(cfg.sqsEndpoint ? { endpoint: cfg.sqsEndpoint } : {}),
      ...(cfg.sqsEndpoint
        ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
        : {}),
    });
  }

  async publish(job: ChannelJob, delaySeconds = 0): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl(this.cfg, job.channel),
        MessageBody: JSON.stringify(job),
        DelaySeconds: Math.min(Math.max(0, Math.floor(delaySeconds)), MAX_SQS_DELAY_SECONDS),
      }),
    );
  }

  /**
   * Fan one message out to its channels. Grouped per channel because SQS batches
   * are per-queue, and each channel has its own queue.
   */
  async publishAll(jobs: ChannelJob[], delaySeconds = 0): Promise<void> {
    const byChannel = new Map<Channel, ChannelJob[]>();
    for (const job of jobs) {
      const list = byChannel.get(job.channel) ?? [];
      list.push(job);
      byChannel.set(job.channel, list);
    }

    await Promise.all(
      [...byChannel.entries()].map(([channel, channelJobs]) =>
        this.publishBatch(channel, channelJobs, delaySeconds),
      ),
    );
  }

  private async publishBatch(
    channel: Channel,
    jobs: ChannelJob[],
    delaySeconds: number,
  ): Promise<void> {
    const delay = Math.min(Math.max(0, Math.floor(delaySeconds)), MAX_SQS_DELAY_SECONDS);
    // SendMessageBatch accepts at most 10 entries per call.
    for (let i = 0; i < jobs.length; i += 10) {
      const slice = jobs.slice(i, i + 10);
      await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl(this.cfg, channel),
          Entries: slice.map((job, idx) => ({
            Id: `${i + idx}`,
            MessageBody: JSON.stringify(job),
            DelaySeconds: delay,
          })),
        }),
      );
    }
  }
}

/** Seconds from now until `when`, floored at 0. */
export function delayUntil(when: Date, now = new Date()): number {
  return Math.max(0, Math.floor((when.getTime() - now.getTime()) / 1000));
}
