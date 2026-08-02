import { describe, expect, it } from 'vitest';
import { isE164, normaliseBdPhone, SmsAdapter } from './sms.adapter';
import { loadConfig } from '../config';
import type { ChannelJob } from '../types';

describe('isE164', () => {
  it('accepts well-formed international numbers', () => {
    expect(isE164('+8801712345678')).toBe(true);
    expect(isE164('+14155552671')).toBe(true);
  });

  it('rejects local formats, spacing and non-digits', () => {
    for (const bad of ['01712345678', '8801712345678', '+880 1712 345678', '+0123456', 'abc', '']) {
      expect(isE164(bad)).toBe(false);
    }
  });
});

describe('normaliseBdPhone', () => {
  it('converts the Bangladeshi formats users actually type', () => {
    expect(normaliseBdPhone('01712345678')).toBe('+8801712345678');
    expect(normaliseBdPhone('8801712345678')).toBe('+8801712345678');
    expect(normaliseBdPhone('+88 017-1234-5678')).toBe('+8801712345678');
    expect(normaliseBdPhone('017 1234 5678')).toBe('+8801712345678');
  });

  it('passes through numbers that are already E.164', () => {
    expect(normaliseBdPhone('+14155552671')).toBe('+14155552671');
  });

  it('returns null for input it cannot place', () => {
    expect(normaliseBdPhone('12345')).toBeNull();
    expect(normaliseBdPhone('not a phone')).toBeNull();
  });
});

describe('SmsAdapter', () => {
  const cfg = loadConfig({ SMS_PROVIDER: 'log', AWS_REGION: 'ap-south-1' });

  function job(overrides: Partial<ChannelJob> = {}): ChannelJob {
    return {
      messageId: 'msg_1',
      tenantId: 'ten_1',
      channel: 'sms',
      category: 'transactional',
      locale: 'en',
      payload: { text: 'Your code is 1234' },
      target: { kind: 'sms', phone: '+8801712345678' },
      attempt: 0,
      ...overrides,
    };
  }

  it('records the message under the log provider', async () => {
    const adapter = new SmsAdapter(cfg);
    const out = await adapter.send(job());

    expect(out.status).toBe('delivered');
    expect(adapter.sent).toEqual([{ phone: '+8801712345678', text: 'Your code is 1234' }]);
  });

  it('fails a non-E.164 number without retrying — it will never become valid', async () => {
    const adapter = new SmsAdapter(cfg);
    const out = await adapter.send(job({ target: { kind: 'sms', phone: '01712345678' } }));

    expect(out.status).toBe('failed');
    expect(out.retryable).toBe(false);
    expect(adapter.sent).toHaveLength(0);
  });

  it('rejects a target meant for another channel', async () => {
    const adapter = new SmsAdapter(cfg);
    const out = await adapter.send(job({ target: { kind: 'email', address: 'a@b.com' } }));

    expect(out.status).toBe('failed');
    expect(out.retryable).toBe(false);
  });

  it('fails fast when bulksmsbd is selected without an API key', async () => {
    const adapter = new SmsAdapter(loadConfig({ SMS_PROVIDER: 'bulksmsbd' }));
    const out = await adapter.send(job());

    expect(out.status).toBe('failed');
    expect(out.retryable).toBe(false);
    expect(out.error).toContain('BULKSMSBD_API_KEY');
  });
});
