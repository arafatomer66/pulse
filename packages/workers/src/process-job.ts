import {
  type Channel,
  type ChannelJob,
  type ChannelResult,
  type PulseContext,
} from '@pulse/core';

/**
 * The single code path every channel worker runs.
 *
 * All five channels share this so retry semantics, attempt logging and result
 * recording cannot drift between them — the only thing that varies is which
 * adapter gets called.
 */

export interface ProcessOutcome {
  /** True when SQS should redeliver this job (and eventually DLQ it). */
  retry: boolean;
  result: ChannelResult;
}

/** Matches maxReceiveCount on every channel queue (infra + elasticmq.conf). */
export const MAX_ATTEMPTS = 3;

export async function processJob(
  ctx: PulseContext,
  job: ChannelJob,
  receiveCount: number,
): Promise<ProcessOutcome> {
  const now = () => new Date().toISOString();

  // A message cancelled after fan-out may still have jobs sitting on the queue.
  // Checking here is what makes cancellation actually stop delivery rather than
  // just relabelling the record.
  const message = await ctx.repos.messages.get(job.messageId);
  if (!message) {
    return {
      retry: false,
      result: skipped(job.channel, 'message record no longer exists', now()),
    };
  }
  if (message.status === 'cancelled') {
    const result = cancelled(job.channel, now());
    await record(ctx, job, result, receiveCount, message.tenantId);
    return { retry: false, result };
  }

  const adapter = ctx.adapters[job.channel];
  const outcome = await adapter.send(job);

  // FCM told us these tokens are permanently dead. Dropping them now keeps
  // every future push to this subscriber from reporting a partial failure.
  if (outcome.invalidTargets?.length && job.subscriberId) {
    await ctx.repos.subscribers
      .pruneDevices(job.tenantId, job.subscriberId, outcome.invalidTargets)
      .catch(() => undefined);
  }

  const exhausted = receiveCount >= MAX_ATTEMPTS;

  // A retryable failure is always reported back to SQS, including on the final
  // attempt. On that last one the queue's maxReceiveCount redrives it to the
  // DLQ instead of redelivering, which is what we want: the operator gets a
  // replayable artifact. Acking the final attempt would record the failure but
  // leave the DLQ empty, so there would be nothing to replay.
  const shouldRetry = outcome.status === 'failed' && outcome.retryable === true;

  const result: ChannelResult = {
    channel: job.channel,
    status: outcome.status,
    providerMessageId: outcome.providerMessageId,
    error: outcome.error,
    reason:
      outcome.status === 'failed' && exhausted
        ? `gave up after ${receiveCount} attempts`
        : undefined,
    attempts: receiveCount,
    updatedAt: now(),
  };

  // An attempt row is written for every try, including ones we will retry —
  // that log is how a delivery failure gets diagnosed after the fact.
  await ctx.repos.messages
    .recordAttempt({
      messageId: job.messageId,
      channel: job.channel,
      status: outcome.status,
      attempt: receiveCount,
      providerMessageId: outcome.providerMessageId,
      error: outcome.error,
      retentionDays: ctx.cfg.messageRetentionDays,
    })
    .catch(() => undefined);

  // Only write the per-channel result when the outcome is final. Recording an
  // intermediate failure would flip the message to `partial` and then back,
  // which anyone polling the status would see as a delivered message failing.
  // "Final" means: succeeded, permanently failed, or out of attempts.
  if (!shouldRetry || exhausted) {
    await ctx.repos.messages.recordResult(job.messageId, result).catch(() => undefined);
  }

  return { retry: shouldRetry, result };
}

async function record(
  ctx: PulseContext,
  job: ChannelJob,
  result: ChannelResult,
  attempt: number,
  _tenantId: string,
): Promise<void> {
  await ctx.repos.messages.recordResult(job.messageId, result).catch(() => undefined);
  await ctx.repos.messages
    .recordAttempt({
      messageId: job.messageId,
      channel: job.channel,
      status: result.status,
      attempt,
      retentionDays: ctx.cfg.messageRetentionDays,
    })
    .catch(() => undefined);
}

function skipped(channel: Channel, reason: string, at: string): ChannelResult {
  return { channel, status: 'skipped', reason, attempts: 0, updatedAt: at };
}

function cancelled(channel: Channel, at: string): ChannelResult {
  return {
    channel,
    status: 'cancelled',
    reason: 'message was cancelled before this channel was delivered',
    attempts: 0,
    updatedAt: at,
  };
}
