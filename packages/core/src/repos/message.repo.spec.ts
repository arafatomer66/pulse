import { describe, expect, it } from 'vitest';
import { rollUpStatus } from './message.repo';
import type { Channel, ChannelResult, DeliveryStatus, Message } from '../types';

function result(channel: Channel, status: DeliveryStatus): ChannelResult {
  return { channel, status, attempts: 1, updatedAt: new Date().toISOString() };
}

function message(channels: Channel[], results: Partial<Record<Channel, ChannelResult>>): Message {
  return {
    messageId: 'msg_1',
    tenantId: 'ten_1',
    category: 'transactional',
    locale: 'en',
    channels,
    status: 'queued',
    rendered: {},
    data: {},
    results,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: 0,
  };
}

describe('rollUpStatus', () => {
  it('stays processing while any channel has not reported', () => {
    const m = message(['email', 'push'], { email: result('email', 'delivered') });
    expect(rollUpStatus(m)).toBe('processing');
  });

  it('is delivered when every channel succeeded', () => {
    const m = message(['email', 'push'], {
      email: result('email', 'delivered'),
      push: result('push', 'delivered'),
    });
    expect(rollUpStatus(m)).toBe('delivered');
  });

  it('is failed when every channel failed', () => {
    const m = message(['email', 'sms'], {
      email: result('email', 'failed'),
      sms: result('sms', 'failed'),
    });
    expect(rollUpStatus(m)).toBe('failed');
  });

  it('is partial on a mix of success and failure', () => {
    const m = message(['email', 'sms'], {
      email: result('email', 'delivered'),
      sms: result('sms', 'failed'),
    });
    expect(rollUpStatus(m)).toBe('partial');
  });

  it('counts suppressed and skipped as settled, not failed', () => {
    // The subscriber opted out of email and has no phone. We did exactly what
    // their preferences asked, so the message is delivered, not failed.
    const m = message(['email', 'sms'], {
      email: result('email', 'suppressed'),
      sms: result('sms', 'skipped'),
    });
    expect(rollUpStatus(m)).toBe('delivered');
  });

  it('treats a suppressed-plus-failed mix as partial', () => {
    const m = message(['email', 'push'], {
      email: result('email', 'suppressed'),
      push: result('push', 'failed'),
    });
    expect(rollUpStatus(m)).toBe('partial');
  });

  it('ignores results for channels the message did not target', () => {
    const m = message(['email'], {
      email: result('email', 'delivered'),
      sms: result('sms', 'failed'),
    });
    expect(rollUpStatus(m)).toBe('delivered');
  });
});
