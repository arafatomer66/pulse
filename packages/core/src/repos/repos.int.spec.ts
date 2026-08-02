import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type PulseConfig } from '../config';
import { createContext, type PulseContext } from '../context';
import { resetDocClient } from '../ddb';
import { generateApiKey, newSubscriberId, newTenantId, ttlSeconds } from '../ids';
import { createTable, dropTable } from '../table';
import { waitForDynamo } from '../testing/wait';
import { PulseError } from '../errors';
import type { Subscriber, Tenant } from '../types';

/**
 * Repository integration tests against DynamoDB Local.
 *
 * These run the real AWS SDK against a real (local) DynamoDB, so conditional
 * writes, atomic counters and index queries are genuinely exercised — a mocked
 * client would happily "pass" a ConditionExpression that DynamoDB rejects.
 *
 * Requires `docker compose up -d`.
 */

const cfg: PulseConfig = loadConfig({
  ...process.env,
  PULSE_TABLE: 'pulse-test-repos',
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8102',
  AWS_REGION: 'ap-south-1',
});

let ctx: PulseContext;

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    tenantId: newTenantId(),
    name: 'Test Co',
    plan: 'growth',
    status: 'active',
    monthlyQuota: 1000,
    rateLimitPerMin: 600,
    retentionDays: 90,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSubscriber(tenantId: string, overrides: Partial<Subscriber> = {}): Subscriber {
  const now = new Date().toISOString();
  return {
    tenantId,
    subscriberId: newSubscriberId(),
    email: 'omer@example.com',
    phone: '+8801712345678',
    locale: 'en',
    timezone: 'Asia/Dhaka',
    attributes: {},
    preferences: { channels: {}, categories: {} },
    topics: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeAll(async () => {
  await waitForDynamo(cfg);
  resetDocClient();
  await dropTable(cfg);
  await createTable(cfg);
  ctx = createContext(cfg);
});

afterAll(async () => {
  await dropTable(cfg);
  resetDocClient();
});

describe('TenantRepo', () => {
  it('round-trips a tenant', async () => {
    const tenant = makeTenant();
    await ctx.repos.tenants.create(tenant);

    const found = await ctx.repos.tenants.get(tenant.tenantId);
    expect(found).toEqual(tenant);
  });

  it('rejects a duplicate tenant id', async () => {
    const tenant = makeTenant();
    await ctx.repos.tenants.create(tenant);

    await expect(ctx.repos.tenants.create(tenant)).rejects.toMatchObject({
      code: 'DUPLICATE_RESOURCE',
    });
  });

  it('throws TENANT_NOT_FOUND for an unknown id', async () => {
    await expect(ctx.repos.tenants.getOrThrow('ten_nope')).rejects.toBeInstanceOf(PulseError);
  });
});

describe('ApiKeyRepo', () => {
  it('authenticates by plaintext without ever storing it', async () => {
    const tenant = makeTenant();
    await ctx.repos.tenants.create(tenant);
    const generated = generateApiKey('pk_live');

    await ctx.repos.apiKeys.create({
      keyHash: generated.hash,
      keyId: 'key_1',
      tenantId: tenant.tenantId,
      name: 'default',
      prefix: 'pk_live',
      last4: generated.last4,
      scopes: ['notifications:send'],
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    const found = await ctx.repos.apiKeys.findByPlaintext(generated.plaintext);
    expect(found?.tenantId).toBe(tenant.tenantId);

    // The stored row must contain the hash and nothing resembling the secret.
    expect(JSON.stringify(found)).not.toContain(generated.plaintext);
  });

  it('returns undefined for a key that was never issued', async () => {
    expect(await ctx.repos.apiKeys.findByPlaintext('pk_live_deadbeef')).toBeUndefined();
  });

  it('marks a key revoked', async () => {
    const generated = generateApiKey('pk_test');
    await ctx.repos.apiKeys.create({
      keyHash: generated.hash,
      keyId: 'key_2',
      tenantId: 'ten_x',
      name: 'to revoke',
      prefix: 'pk_test',
      last4: generated.last4,
      scopes: [],
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    await ctx.repos.apiKeys.revoke(generated.hash);
    expect((await ctx.repos.apiKeys.findByHash(generated.hash))?.status).toBe('revoked');
  });
});

describe('TemplateRepo', () => {
  it('auto-increments versions and getLatest returns the newest', async () => {
    const tenantId = newTenantId();
    const base = {
      tenantId,
      key: 'welcome',
      name: 'Welcome',
      category: 'transactional',
      locales: { en: { sms: { text: 'v1' } } },
    };

    const v1 = await ctx.repos.templates.publish(base);
    const v2 = await ctx.repos.templates.publish({
      ...base,
      locales: { en: { sms: { text: 'v2' } } },
    });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);

    const latest = await ctx.repos.templates.getLatest(tenantId, 'welcome');
    expect(latest?.version).toBe(2);
    expect(latest?.locales.en.sms?.text).toBe('v2');
  });

  it('sorts v10 after v9 — the version suffix is zero-padded', async () => {
    const tenantId = newTenantId();
    const base = {
      tenantId,
      key: 'many',
      name: 'Many',
      category: 'transactional',
      locales: { en: { sms: { text: 'x' } } },
    };
    for (let i = 0; i < 10; i++) await ctx.repos.templates.publish(base);

    // Lexical sort on an unpadded number would put "9" above "10" and return v9.
    expect((await ctx.repos.templates.getLatest(tenantId, 'many'))?.version).toBe(10);
  });

  it('keeps old versions readable', async () => {
    const tenantId = newTenantId();
    const base = {
      tenantId,
      key: 'hist',
      name: 'Hist',
      category: 'transactional',
      locales: { en: { sms: { text: 'first' } } },
    };
    await ctx.repos.templates.publish(base);
    await ctx.repos.templates.publish({ ...base, locales: { en: { sms: { text: 'second' } } } });

    const v1 = await ctx.repos.templates.getVersion(tenantId, 'hist', 1);
    expect(v1?.locales.en.sms?.text).toBe('first');
  });

  it('lists only the newest version of each key', async () => {
    const tenantId = newTenantId();
    for (const key of ['a', 'b']) {
      await ctx.repos.templates.publish({
        tenantId,
        key,
        name: key,
        category: 'transactional',
        locales: { en: { sms: { text: 'v1' } } },
      });
      await ctx.repos.templates.publish({
        tenantId,
        key,
        name: key,
        category: 'transactional',
        locales: { en: { sms: { text: 'v2' } } },
      });
    }

    const list = await ctx.repos.templates.listLatest(tenantId);
    expect(list.map((t) => `${t.key}v${t.version}`)).toEqual(['av2', 'bv2']);
  });
});

describe('SubscriberRepo', () => {
  it('round-trips a subscriber and finds it by externalId', async () => {
    const tenantId = newTenantId();
    const sub = makeSubscriber(tenantId, { externalId: 'user-42' });
    await ctx.repos.subscribers.put(sub);

    expect((await ctx.repos.subscribers.get(tenantId, sub.subscriberId))?.email).toBe(
      'omer@example.com',
    );
    expect((await ctx.repos.subscribers.findByExternalId(tenantId, 'user-42'))?.subscriberId).toBe(
      sub.subscriberId,
    );
  });

  it('stores and prunes device tokens', async () => {
    const tenantId = newTenantId();
    const sub = makeSubscriber(tenantId);
    await ctx.repos.subscribers.put(sub);

    const now = new Date().toISOString();
    for (const token of ['tok-a', 'tok-b']) {
      await ctx.repos.subscribers.addDevice({
        tenantId,
        subscriberId: sub.subscriberId,
        token,
        platform: 'android',
        createdAt: now,
        lastSeenAt: now,
      });
    }

    expect(await ctx.repos.subscribers.listDevices(tenantId, sub.subscriberId)).toHaveLength(2);

    await ctx.repos.subscribers.pruneDevices(tenantId, sub.subscriberId, ['tok-a']);
    const left = await ctx.repos.subscribers.listDevices(tenantId, sub.subscriberId);
    expect(left.map((d) => d.token)).toEqual(['tok-b']);
  });
});

describe('MessageRepo', () => {
  async function seedMessage(tenantId: string) {
    const now = new Date().toISOString();
    return ctx.repos.messages.create({
      messageId: `msg_${Math.random().toString(36).slice(2, 10)}`,
      tenantId,
      category: 'transactional',
      locale: 'en',
      channels: ['email', 'sms'],
      status: 'queued',
      rendered: {},
      data: {},
      results: {},
      createdAt: now,
      updatedAt: now,
      expiresAt: ttlSeconds(90),
    });
  }

  it('records per-channel results and rolls the status up', async () => {
    const tenantId = newTenantId();
    const msg = await seedMessage(tenantId);

    await ctx.repos.messages.recordResult(msg.messageId, {
      channel: 'email',
      status: 'delivered',
      attempts: 1,
      updatedAt: new Date().toISOString(),
    });
    // One of two channels reported — still in flight.
    expect((await ctx.repos.messages.get(msg.messageId))?.status).toBe('processing');

    const after = await ctx.repos.messages.recordResult(msg.messageId, {
      channel: 'sms',
      status: 'failed',
      error: 'gateway rejected',
      attempts: 3,
      updatedAt: new Date().toISOString(),
    });
    expect(after.status).toBe('partial');
  });

  it('lets concurrent channel workers write without losing each other updates', async () => {
    const tenantId = newTenantId();
    const msg = await seedMessage(tenantId);

    // This is the case a results *list* would break: read-modify-write from two
    // workers at once drops one result. A map keyed by channel cannot.
    await Promise.all([
      ctx.repos.messages.recordResult(msg.messageId, {
        channel: 'email',
        status: 'delivered',
        attempts: 1,
        updatedAt: new Date().toISOString(),
      }),
      ctx.repos.messages.recordResult(msg.messageId, {
        channel: 'sms',
        status: 'delivered',
        attempts: 1,
        updatedAt: new Date().toISOString(),
      }),
    ]);

    const found = await ctx.repos.messages.get(msg.messageId);
    expect(Object.keys(found?.results ?? {}).sort()).toEqual(['email', 'sms']);
    expect(found?.status).toBe('delivered');
  });

  it('scopes reads to the owning tenant', async () => {
    const owner = newTenantId();
    const intruder = newTenantId();
    const msg = await seedMessage(owner);

    await expect(ctx.repos.messages.getForTenant(owner, msg.messageId)).resolves.toMatchObject({
      messageId: msg.messageId,
    });
    // Knowing the id is not enough — this is the tenant-isolation guarantee.
    await expect(ctx.repos.messages.getForTenant(intruder, msg.messageId)).rejects.toMatchObject({
      code: 'MESSAGE_NOT_FOUND',
    });
  });

  it('lists a tenant delivery log newest-first via GSI1', async () => {
    const tenantId = newTenantId();
    const a = await seedMessage(tenantId);
    await new Promise((r) => setTimeout(r, 5));
    const b = await seedMessage(tenantId);

    const page = await ctx.repos.messages.listByTenant(tenantId);
    expect(page.items.map((m) => m.messageId)).toEqual([b.messageId, a.messageId]);
  });

  it('cancels a scheduled message but not one already delivering', async () => {
    const tenantId = newTenantId();
    const scheduled = await seedMessage(tenantId);
    await ctx.repos.messages.setStatus(scheduled.messageId, 'scheduled');

    const cancelled = await ctx.repos.messages.cancel(tenantId, scheduled.messageId);
    expect(cancelled.status).toBe('cancelled');

    const inFlight = await seedMessage(tenantId);
    await ctx.repos.messages.setStatus(inFlight.messageId, 'processing');
    await expect(ctx.repos.messages.cancel(tenantId, inFlight.messageId)).rejects.toMatchObject({
      code: 'MESSAGE_NOT_CANCELLABLE',
    });
  });

  it('appends an attempt log per try', async () => {
    const tenantId = newTenantId();
    const msg = await seedMessage(tenantId);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await ctx.repos.messages.recordAttempt({
        messageId: msg.messageId,
        channel: 'email',
        status: attempt === 3 ? 'delivered' : 'failed',
        attempt,
        retentionDays: 90,
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    const attempts = await ctx.repos.messages.listAttempts(msg.messageId);
    expect(attempts).toHaveLength(3);
    expect(attempts.at(-1)?.status).toBe('delivered');
  });
});

describe('InboxRepo', () => {
  it('feeds newest-first, counts unread and marks read idempotently', async () => {
    const tenantId = newTenantId();
    const subscriberId = newSubscriberId();

    for (const title of ['first', 'second', 'third']) {
      await ctx.repos.inbox.add({
        tenantId,
        subscriberId,
        itemId: (await import('../ids')).newId(),
        messageId: 'msg_1',
        title,
        body: title,
        category: 'transactional',
        createdAt: new Date().toISOString(),
        expiresAt: ttlSeconds(90),
      });
    }

    const page = await ctx.repos.inbox.list(tenantId, subscriberId);
    expect(page.items.map((i) => i.title)).toEqual(['third', 'second', 'first']);
    expect(await ctx.repos.inbox.unreadCount(tenantId, subscriberId)).toBe(3);

    const target = page.items[0]!;
    await ctx.repos.inbox.markRead(tenantId, subscriberId, target.itemId);
    expect(await ctx.repos.inbox.unreadCount(tenantId, subscriberId)).toBe(2);

    // Re-reading an already-read item must not throw or move the stamp.
    await expect(
      ctx.repos.inbox.markRead(tenantId, subscriberId, target.itemId),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });

    expect(await ctx.repos.inbox.markAllRead(tenantId, subscriberId)).toBe(2);
    expect(await ctx.repos.inbox.unreadCount(tenantId, subscriberId)).toBe(0);
  });
});

describe('SuppressionRepo', () => {
  it('suppresses an email case-insensitively', async () => {
    const tenantId = newTenantId();
    await ctx.repos.suppression.add({
      tenantId,
      channel: 'email',
      address: 'Bounced@Example.COM',
      reason: 'bounce',
      createdAt: new Date().toISOString(),
    });

    // Both spellings must hit the same row, or a re-send with different casing
    // would slip past the list and damage sender reputation.
    expect(await ctx.repos.suppression.isSuppressed(tenantId, 'email', 'bounced@example.com')).toBe(
      true,
    );
    expect(await ctx.repos.suppression.isSuppressed(tenantId, 'email', 'BOUNCED@EXAMPLE.com')).toBe(
      true,
    );
    expect(await ctx.repos.suppression.isSuppressed(tenantId, 'email', 'other@example.com')).toBe(
      false,
    );
  });

  it('scopes suppression per tenant', async () => {
    const a = newTenantId();
    const b = newTenantId();
    await ctx.repos.suppression.add({
      tenantId: a,
      channel: 'email',
      address: 'x@example.com',
      reason: 'complaint',
      createdAt: new Date().toISOString(),
    });

    expect(await ctx.repos.suppression.isSuppressed(a, 'email', 'x@example.com')).toBe(true);
    expect(await ctx.repos.suppression.isSuppressed(b, 'email', 'x@example.com')).toBe(false);
  });

  it('removes an entry on request', async () => {
    const tenantId = newTenantId();
    await ctx.repos.suppression.add({
      tenantId,
      channel: 'sms',
      address: '+8801712345678',
      reason: 'unsubscribe',
      createdAt: new Date().toISOString(),
    });
    await ctx.repos.suppression.remove(tenantId, 'sms', '+8801712345678');
    expect(await ctx.repos.suppression.isSuppressed(tenantId, 'sms', '+8801712345678')).toBe(false);
  });
});

describe('IdempotencyRepo', () => {
  const body = { to: { email: 'a@b.com' }, templateKey: 'welcome' };

  it('claims once, then replays the stored response', async () => {
    const tenantId = newTenantId();

    expect(await ctx.repos.idempotency.claim(tenantId, 'key-1', body)).toEqual({
      outcome: 'claimed',
    });

    // Second call while the first is still running.
    expect(await ctx.repos.idempotency.claim(tenantId, 'key-1', body)).toEqual({
      outcome: 'in_flight',
    });

    await ctx.repos.idempotency.complete(tenantId, 'key-1', { messageId: 'msg_1' }, 202);

    expect(await ctx.repos.idempotency.claim(tenantId, 'key-1', body)).toEqual({
      outcome: 'replay',
      response: { messageId: 'msg_1' },
      statusCode: 202,
    });
  });

  it('ignores key order when hashing the request body', async () => {
    const tenantId = newTenantId();
    await ctx.repos.idempotency.claim(tenantId, 'key-2', { a: 1, b: 2 });

    // Same request, different literal key order — must be treated as a retry.
    await expect(
      ctx.repos.idempotency.claim(tenantId, 'key-2', { b: 2, a: 1 }),
    ).resolves.toEqual({ outcome: 'in_flight' });
  });

  it('rejects the same key used for a different payload', async () => {
    const tenantId = newTenantId();
    await ctx.repos.idempotency.claim(tenantId, 'key-3', body);

    await expect(
      ctx.repos.idempotency.claim(tenantId, 'key-3', { ...body, templateKey: 'other' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('releases a claim so a genuinely failed request can be retried', async () => {
    const tenantId = newTenantId();
    await ctx.repos.idempotency.claim(tenantId, 'key-4', body);
    await ctx.repos.idempotency.release(tenantId, 'key-4');

    expect(await ctx.repos.idempotency.claim(tenantId, 'key-4', body)).toEqual({
      outcome: 'claimed',
    });
  });

  it('scopes keys per tenant', async () => {
    const a = newTenantId();
    const b = newTenantId();
    await ctx.repos.idempotency.claim(a, 'shared-key', body);

    expect(await ctx.repos.idempotency.claim(b, 'shared-key', body)).toEqual({
      outcome: 'claimed',
    });
  });
});

describe('UsageRepo', () => {
  it('enforces the monthly quota with an atomic counter', async () => {
    const tenantId = newTenantId();

    await ctx.repos.usage.consumeQuota(tenantId, 2);
    await ctx.repos.usage.consumeQuota(tenantId, 2);

    await expect(ctx.repos.usage.consumeQuota(tenantId, 2)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });

    const snap = await ctx.repos.usage.snapshot(tenantId, 2);
    expect(snap.sent).toBe(2);
    expect(snap.remaining).toBe(0);
  });

  it('records a per-channel breakdown alongside the billable total', async () => {
    const tenantId = newTenantId();

    await ctx.repos.usage.consumeQuota(tenantId, 10);
    await ctx.repos.usage.recordChannels(tenantId, ['email', 'sms']);
    await ctx.repos.usage.consumeQuota(tenantId, 10);
    await ctx.repos.usage.recordChannels(tenantId, ['email']);

    const snap = await ctx.repos.usage.snapshot(tenantId, 10);
    // Two messages billed, but three channel deliveries across them.
    expect(snap.sent).toBe(2);
    expect(snap.byChannel.email).toBe(2);
    expect(snap.byChannel.sms).toBe(1);
  });

  it('handles an empty or duplicated channel list without erroring', async () => {
    const tenantId = newTenantId();
    // DynamoDB rejects an empty ExpressionAttributeNames map, and rejects an
    // expression touching the same attribute twice. Both must be absorbed here.
    await expect(ctx.repos.usage.recordChannels(tenantId, [])).resolves.toBeUndefined();
    await expect(
      ctx.repos.usage.recordChannels(tenantId, ['email', 'email', 'push']),
    ).resolves.toBeUndefined();

    const snap = await ctx.repos.usage.snapshot(tenantId, 10);
    expect(snap.byChannel.email).toBe(1);
    expect(snap.byChannel.push).toBe(1);
  });

  it('holds the quota line under concurrent sends', async () => {
    const tenantId = newTenantId();
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => ctx.repos.usage.consumeQuota(tenantId, 5)),
    );

    const accepted = attempts.filter((r) => r.status === 'fulfilled').length;
    // The whole point of the conditional ADD: exactly 5 get through, no matter
    // how many race.
    expect(accepted).toBe(5);
    expect((await ctx.repos.usage.snapshot(tenantId, 5)).sent).toBe(5);
  });

  it('refunds a unit without ever going negative', async () => {
    const tenantId = newTenantId();
    await ctx.repos.usage.consumeQuota(tenantId, 10);

    await ctx.repos.usage.refund(tenantId);
    expect((await ctx.repos.usage.snapshot(tenantId, 10)).sent).toBe(0);

    // Extra refunds are swallowed rather than handing out free quota.
    await ctx.repos.usage.refund(tenantId);
    expect((await ctx.repos.usage.snapshot(tenantId, 10)).sent).toBe(0);
  });

  it('rate-limits per minute', async () => {
    const tenantId = newTenantId();
    const at = new Date('2026-08-02T10:00:00.000Z');

    await ctx.repos.usage.consumeRateToken(tenantId, 2, at);
    await ctx.repos.usage.consumeRateToken(tenantId, 2, at);
    await expect(ctx.repos.usage.consumeRateToken(tenantId, 2, at)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });

    // The next minute is a fresh bucket.
    await expect(
      ctx.repos.usage.consumeRateToken(tenantId, 2, new Date('2026-08-02T10:01:00.000Z')),
    ).resolves.toBeUndefined();
  });
});

describe('WebhookRepo', () => {
  it('filters endpoints by event and status', async () => {
    const tenantId = newTenantId();
    const now = new Date().toISOString();

    await ctx.repos.webhooks.put({
      tenantId,
      endpointId: 'whe_all',
      url: 'https://example.com/all',
      secret: 's1',
      events: ['*'],
      status: 'active',
      createdAt: now,
    });
    await ctx.repos.webhooks.put({
      tenantId,
      endpointId: 'whe_specific',
      url: 'https://example.com/shipped',
      secret: 's2',
      events: ['order.shipped'],
      status: 'active',
      createdAt: now,
    });
    await ctx.repos.webhooks.put({
      tenantId,
      endpointId: 'whe_off',
      url: 'https://example.com/off',
      secret: 's3',
      events: ['*'],
      status: 'disabled',
      createdAt: now,
    });

    const forShipped = await ctx.repos.webhooks.listForEvent(tenantId, 'order.shipped');
    expect(forShipped.map((e) => e.endpointId).sort()).toEqual(['whe_all', 'whe_specific']);

    const forOther = await ctx.repos.webhooks.listForEvent(tenantId, 'order.cancelled');
    expect(forOther.map((e) => e.endpointId)).toEqual(['whe_all']);
  });
});
