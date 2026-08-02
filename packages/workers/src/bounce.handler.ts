import { createContext, type PulseContext, type SuppressionEntry } from '@pulse/core';
import type { SNSEvent, SNSHandler } from 'aws-lambda';

/**
 * SES bounce and complaint feedback, delivered via SNS.
 *
 * This is not optional plumbing. AWS measures bounce and complaint rates per
 * account and will throttle or suspend sending that stays above roughly 5% and
 * 0.1% respectively. Recording these addresses so the dispatcher skips them is
 * what keeps the account's ability to send email at all.
 */

let cached: PulseContext | undefined;
function context(): PulseContext {
  cached ??= createContext();
  return cached;
}

interface SesNotification {
  notificationType?: 'Bounce' | 'Complaint' | 'Delivery';
  eventType?: 'Bounce' | 'Complaint' | 'Delivery';
  mail?: {
    messageId?: string;
    // Pulse stamps the tenant here when sending via SES so feedback can be
    // attributed — suppression is per-tenant, not global.
    tags?: Record<string, string[]>;
  };
  bounce?: {
    bounceType?: 'Permanent' | 'Transient' | 'Undetermined';
    bounceSubType?: string;
    bouncedRecipients?: Array<{ emailAddress: string; diagnosticCode?: string }>;
  };
  complaint?: {
    complainedRecipients?: Array<{ emailAddress: string }>;
    complaintFeedbackType?: string;
  };
}

export const bounceHandler: SNSHandler = async (event: SNSEvent): Promise<void> => {
  const ctx = context();

  for (const record of event.Records) {
    let notification: SesNotification;
    try {
      notification = JSON.parse(record.Sns.Message) as SesNotification;
    } catch {
      console.error('SES feedback: message is not valid JSON, skipping');
      continue;
    }

    const type = notification.notificationType ?? notification.eventType;
    const tenantId = notification.mail?.tags?.pulse_tenant?.[0];

    if (!tenantId) {
      // Without a tenant we cannot scope the suppression, and a global
      // suppression list would let one tenant's bounce block another's sends.
      console.error('SES feedback: no pulse_tenant tag on the message, cannot attribute');
      continue;
    }

    if (type === 'Bounce') {
      await handleBounce(ctx, tenantId, notification);
    } else if (type === 'Complaint') {
      await handleComplaint(ctx, tenantId, notification);
    }
  }
};

async function handleBounce(
  ctx: PulseContext,
  tenantId: string,
  notification: SesNotification,
): Promise<void> {
  const bounce = notification.bounce;
  // Transient bounces (full mailbox, temporary DNS failure) resolve on their
  // own. Suppressing on those would permanently cut off recipients over a
  // problem that lasted an afternoon.
  if (bounce?.bounceType !== 'Permanent') {
    console.log(`SES ${bounce?.bounceType ?? 'unknown'} bounce for ${tenantId}: not suppressing`);
    return;
  }

  for (const recipient of bounce.bouncedRecipients ?? []) {
    await addSuppression(ctx, {
      tenantId,
      channel: 'email',
      address: recipient.emailAddress,
      reason: 'bounce',
      detail: `${bounce.bounceSubType ?? 'Permanent'}: ${recipient.diagnosticCode ?? 'no diagnostic'}`,
      createdAt: new Date().toISOString(),
    });
  }
}

async function handleComplaint(
  ctx: PulseContext,
  tenantId: string,
  notification: SesNotification,
): Promise<void> {
  // Every complaint is suppressed regardless of feedback type — someone marked
  // this as spam, and continuing to mail them is what gets an account banned.
  for (const recipient of notification.complaint?.complainedRecipients ?? []) {
    await addSuppression(ctx, {
      tenantId,
      channel: 'email',
      address: recipient.emailAddress,
      reason: 'complaint',
      detail: notification.complaint?.complaintFeedbackType ?? 'abuse',
      createdAt: new Date().toISOString(),
    });
  }
}

async function addSuppression(ctx: PulseContext, entry: SuppressionEntry): Promise<void> {
  try {
    await ctx.repos.suppression.add(entry);
    console.log(`suppressed ${entry.address} for ${entry.tenantId} (${entry.reason})`);
  } catch (e) {
    // Throwing would fail the whole SNS batch and redeliver every recipient in
    // it; one failed write is better logged and moved past.
    console.error(`failed to suppress ${entry.address}:`, e);
  }
}
