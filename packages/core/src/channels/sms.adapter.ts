import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { PulseConfig } from '../config';
import type { ChannelJob, SendOutcome } from '../types';
import type { RenderedSms } from '../render/renderer';
import { type ChannelAdapter, errorMessage, isRetryableProviderError } from './adapter';

/**
 * SMS delivery.
 *
 * Bangladesh is the primary market and SNS is a poor fit there — it is priced
 * per-message at international rates and alphanumeric sender IDs are restricted.
 * So `bulksmsbd` is the intended production provider (greenweb.com.bd, chosen in
 * sharedeal-social/spec/VENDORS.md V-02) and SNS is kept for other geographies.
 *
 * Until the vendor contract lands, `log` is the default: it records the message
 * and reports success, which is the same posture as the existing
 * `auth.service.ts` OTP path.
 */
export class SmsAdapter implements ChannelAdapter {
  readonly name = 'sms';
  private sns?: SNSClient;
  readonly sent: Array<{ phone: string; text: string }> = [];

  constructor(private readonly cfg: PulseConfig) {}

  async send(job: ChannelJob): Promise<SendOutcome> {
    if (job.target.kind !== 'sms') {
      return { status: 'failed', error: 'sms adapter got a non-sms target', retryable: false };
    }
    const phone = job.target.phone;
    const { text } = job.payload as RenderedSms;

    if (!isE164(phone)) {
      return { status: 'failed', error: `phone ${phone} is not E.164`, retryable: false };
    }

    try {
      switch (this.cfg.smsProvider) {
        case 'sns':
          return await this.sendViaSns(phone, text);
        case 'bulksmsbd':
          return await this.sendViaBulkSmsBd(phone, text);
        case 'log':
          this.sent.push({ phone, text });
          return { status: 'delivered', providerMessageId: `log-${Date.now()}` };
      }
    } catch (e) {
      return { status: 'failed', error: errorMessage(e), retryable: isRetryableProviderError(e) };
    }
  }

  private async sendViaSns(phone: string, text: string): Promise<SendOutcome> {
    this.sns ??= new SNSClient({ region: this.cfg.region });
    const res = await this.sns.send(
      new PublishCommand({
        PhoneNumber: phone,
        Message: text,
        MessageAttributes: {
          'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: this.cfg.smsSenderId },
          // Transactional gets priority routing and higher delivery rates than
          // Promotional; OTPs must not be deprioritised.
          'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
        },
      }),
    );
    return { status: 'delivered', providerMessageId: res.MessageId };
  }

  /**
   * BulkSMS BD (greenweb.com.bd) HTTP API. Their gateway returns HTTP 200 with a
   * status code in the body even for failures, so the body must be inspected —
   * checking `res.ok` alone would report every rejection as a success.
   */
  private async sendViaBulkSmsBd(phone: string, text: string): Promise<SendOutcome> {
    const apiKey = this.cfg.bulkSmsBdApiKey;
    if (!apiKey) {
      return { status: 'failed', error: 'BULKSMSBD_API_KEY is not set', retryable: false };
    }

    const body = new URLSearchParams({
      api_key: apiKey,
      senderid: this.cfg.bulkSmsBdSenderId ?? this.cfg.smsSenderId,
      // The gateway wants local format without the leading '+'.
      number: phone.replace(/^\+/, ''),
      message: text,
    });

    const res = await fetch('https://bulksmsbd.net/api/smsapi', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    const raw = await res.text();
    if (!res.ok) {
      return {
        status: 'failed',
        error: `bulksmsbd http ${res.status}: ${raw.slice(0, 200)}`,
        retryable: res.status >= 500 || res.status === 429,
      };
    }

    // Documented success envelope is {"response_code":202,...}.
    let code: number | undefined;
    let message = raw.slice(0, 200);
    try {
      const parsed = JSON.parse(raw) as { response_code?: number; success_message?: string; error_message?: string };
      code = parsed.response_code;
      message = parsed.success_message ?? parsed.error_message ?? message;
    } catch {
      // Non-JSON body — fall through and treat as a failure with the raw text.
    }

    if (code === 202) {
      return { status: 'delivered', providerMessageId: `bulksmsbd:${Date.now()}` };
    }
    return {
      status: 'failed',
      error: `bulksmsbd code ${code ?? 'unknown'}: ${message}`,
      // 1007 = insufficient balance, 1011 = invalid number: retrying won't help.
      retryable: code === undefined || (code >= 5000 && code < 6000),
    };
  }
}

/** E.164: leading +, country code 1-9, up to 15 digits total. */
export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/**
 * Normalise the Bangladeshi formats users actually type (`01712345678`,
 * `8801712345678`, `+88 017-1234-5678`) into E.164. Non-BD numbers are returned
 * unchanged if already E.164, otherwise null.
 */
export function normaliseBdPhone(input: string): string | null {
  const trimmed = input.replace(/[\s()-]/g, '');
  if (isE164(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (/^01\d{9}$/.test(digits)) return `+88${digits}`;
  if (/^8801\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}
