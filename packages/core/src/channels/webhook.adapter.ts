import { createHmac } from 'node:crypto';
import { safeEqual } from '../ids';
import type { ChannelJob, SendOutcome } from '../types';
import type { RenderedWebhook } from '../render/renderer';
import { type ChannelAdapter, errorMessage } from './adapter';

/**
 * Outbound webhooks.
 *
 * Signed like Stripe's scheme: `Pulse-Signature: t=<unix>,v1=<hex hmac>` over
 * `"<t>.<raw body>"`. Including the timestamp inside the signed string is what
 * makes replay protection possible — signing the body alone would let anyone
 * who captured one request replay it forever.
 */

export const SIGNATURE_HEADER = 'pulse-signature';
const TIMEOUT_MS = 10_000;

export class WebhookAdapter implements ChannelAdapter {
  readonly name = 'webhook';
  readonly sent: Array<{ url: string; event: string }> = [];

  async send(job: ChannelJob): Promise<SendOutcome> {
    if (job.target.kind !== 'webhook') {
      return {
        status: 'failed',
        error: 'webhook adapter got a non-webhook target',
        retryable: false,
      };
    }
    const endpoints = job.target.endpoints;
    if (endpoints.length === 0) {
      return { status: 'suppressed', error: 'no active webhook endpoints' };
    }

    const rendered = job.payload as RenderedWebhook;
    const body = JSON.stringify({
      id: job.messageId,
      event: rendered.event,
      createdAt: new Date().toISOString(),
      data: rendered.payload,
    });

    const results = await Promise.all(
      endpoints.map((e) => this.deliver(e.url, e.secret, body, rendered.event)),
    );

    const failures = results.filter((r) => !r.ok);
    if (failures.length === 0) {
      return { status: 'delivered', providerMessageId: `hooks:${endpoints.length}` };
    }
    return {
      status: failures.length === results.length ? 'failed' : 'delivered',
      error: failures.map((f) => f.error).join('; '),
      // Retry only while at least one failure could plausibly succeed later.
      retryable: failures.some((f) => f.retryable),
    };
  }

  private async deliver(
    url: string,
    secret: string,
    body: string,
    event: string,
  ): Promise<{ ok: boolean; error?: string; retryable: boolean }> {
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Pulse/1.0',
          'pulse-event': event,
          [SIGNATURE_HEADER]: buildSignature(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.ok) {
        this.sent.push({ url, event });
        return { ok: true, retryable: false };
      }
      return {
        ok: false,
        error: `${url} -> HTTP ${res.status}`,
        // 4xx means the receiver rejected the payload; resending is pointless.
        // 408/429 are the exceptions — the receiver asked us to back off.
        retryable: res.status >= 500 || res.status === 408 || res.status === 429,
      };
    } catch (e) {
      // Network error / timeout — always worth another attempt.
      return { ok: false, error: `${url} -> ${errorMessage(e)}`, retryable: true };
    }
  }
}

export function buildSignature(secret: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verify an inbound Pulse webhook. Shipped to consumers via the SDK so they do
 * not hand-roll (and get wrong) the constant-time comparison.
 *
 * @param toleranceSeconds reject signatures older than this to stop replays.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k?.trim() ?? '', v?.trim() ?? ''];
    }),
  );

  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return safeEqual(expected, v1);
}
