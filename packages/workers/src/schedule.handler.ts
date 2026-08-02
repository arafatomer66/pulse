import { createContext, Dispatcher, type PulseContext } from '@pulse/core';
import type { Handler } from 'aws-lambda';

/**
 * Scheduled-send sweeper, driven by an EventBridge rule every minute.
 *
 * SQS caps DelaySeconds at 15 minutes, so anything further out is parked in the
 * GSI3 due queue and picked up here. Two instances can run concurrently without
 * double-sending: claiming a message is a conditional write, and only the
 * winner enqueues it.
 */

let cached: PulseContext | undefined;
function context(): PulseContext {
  cached ??= createContext();
  return cached;
}

export interface SweepResult {
  due: number;
  enqueued: number;
  skipped: number;
}

/** One page per invocation; the next tick picks up the rest. */
const BATCH_LIMIT = 100;

export const scheduleHandler: Handler<unknown, SweepResult> = async (): Promise<SweepResult> => {
  const ctx = context();
  const dispatcher = new Dispatcher(ctx);

  const due = await ctx.repos.messages.listDueScheduled(new Date(), BATCH_LIMIT);
  let enqueued = 0;
  let skipped = 0;

  for (const message of due) {
    // Cancelled after being scheduled — drop it out of the due queue without
    // sending. The claim also flips status to `queued`, so this ordering
    // matters: check first, then claim.
    if (message.status === 'cancelled') {
      await ctx.repos.messages.claimScheduled(message.messageId).catch(() => undefined);
      skipped++;
      continue;
    }

    // Conditional claim. A concurrent sweeper that already took this message
    // loses the condition and we move on rather than enqueueing it twice.
    const claimed = await ctx.repos.messages.claimScheduled(message.messageId);
    if (!claimed) {
      skipped++;
      continue;
    }

    try {
      const tenant = await ctx.repos.tenants.get(message.tenantId);
      if (!tenant || tenant.status === 'suspended') {
        skipped++;
        continue;
      }

      const jobs = await dispatcher.resumeScheduled(tenant, message);
      if (jobs.length > 0) enqueued++;
      else skipped++;
    } catch (e) {
      // The claim is already spent, so this message will not be retried by a
      // later sweep. Log loudly — this is a dropped notification.
      console.error(`schedule sweep failed for ${message.messageId}:`, e);
      skipped++;
    }
  }

  if (due.length > 0) {
    console.log(`schedule sweep: ${due.length} due, ${enqueued} enqueued, ${skipped} skipped`);
  }
  return { due: due.length, enqueued, skipped };
};
