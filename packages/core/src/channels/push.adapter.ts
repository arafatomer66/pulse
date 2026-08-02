import { readFileSync } from 'node:fs';
import type { PulseConfig } from '../config';
import type { ChannelJob, SendOutcome } from '../types';
import type { RenderedPush } from '../render/renderer';
import { type ChannelAdapter, errorMessage, isRetryableProviderError } from './adapter';

/**
 * Push delivery via Firebase Cloud Messaging.
 *
 * APNs is routed *through* FCM rather than integrated directly: one credential,
 * one code path, and FCM handles the APNs token/certificate lifecycle. A direct
 * APNs adapter can be added later behind this same interface if we ever need
 * APNs-only features.
 *
 * firebase-admin is imported lazily so that Lambdas which never send push (and
 * local runs with PUSH_PROVIDER=log) do not pay its cold-start cost.
 */
export class PushAdapter implements ChannelAdapter {
  readonly name = 'push';
  private messaging?: import('firebase-admin/messaging').Messaging;
  readonly sent: Array<{ tokens: string[]; title: string }> = [];

  constructor(private readonly cfg: PulseConfig) {}

  async send(job: ChannelJob): Promise<SendOutcome> {
    if (job.target.kind !== 'push') {
      return { status: 'failed', error: 'push adapter got a non-push target', retryable: false };
    }
    const tokens = job.target.tokens;
    const payload = job.payload as RenderedPush;

    if (tokens.length === 0) {
      // Not a failure: the subscriber simply has no registered device.
      return { status: 'suppressed', error: 'no device tokens registered' };
    }

    if (this.cfg.pushProvider === 'log') {
      this.sent.push({ tokens, title: payload.title });
      return { status: 'delivered', providerMessageId: `log-${Date.now()}` };
    }

    try {
      const messaging = await this.getMessaging();
      const res = await messaging.sendEachForMulticast({
        tokens,
        notification: {
          title: payload.title,
          body: payload.body,
          ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
        },
        data: payload.data ?? {},
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });

      // Collect tokens FCM says are permanently dead so the worker can prune
      // them. Leaving them registered would make every future push to this
      // subscriber report a partial failure forever.
      const invalidTargets: string[] = [];
      res.responses.forEach((r, idx) => {
        const token = tokens[idx];
        if (!r.success && token && isUnregistered(r.error?.code)) invalidTargets.push(token);
      });

      if (res.successCount === 0) {
        const firstError = res.responses.find((r) => !r.success)?.error;
        return {
          status: 'failed',
          error: firstError?.message ?? 'all push sends failed',
          // Every token being dead is permanent; a transient FCM outage is not.
          retryable: invalidTargets.length !== tokens.length,
          invalidTargets,
        };
      }

      return {
        status: 'delivered',
        providerMessageId: `fcm:${res.successCount}/${tokens.length}`,
        invalidTargets,
      };
    } catch (e) {
      return { status: 'failed', error: errorMessage(e), retryable: isRetryableProviderError(e) };
    }
  }

  private async getMessaging(): Promise<import('firebase-admin/messaging').Messaging> {
    if (this.messaging) return this.messaging;

    const { cert, initializeApp, getApps } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');

    if (getApps().length === 0) {
      const path = this.cfg.fcmServiceAccountJson;
      if (!path) {
        throw new Error('PUSH_PROVIDER=fcm but FCM_SERVICE_ACCOUNT_JSON is not set');
      }
      const serviceAccount = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
      initializeApp({ credential: cert(serviceAccount) });
    }
    this.messaging = getMessaging();
    return this.messaging;
  }
}

/** FCM's permanent-failure codes for a token that will never work again. */
function isUnregistered(code: string | undefined): boolean {
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/invalid-argument'
  );
}
