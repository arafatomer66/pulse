import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  createTable,
  dropTable,
  generateApiKey,
  newEndpointId,
  newKeyId,
  newSubscriberId,
  newTenantId,
  queueUrl,
  SCOPES,
  verifySignature,
  waitForDynamo,
  waitForMailhog,
  waitForSqs,
  type PulseConfig,
  type PulseContext,
  type Tenant,
} from '@pulse/core';
import {
  contextFor,
  drain,
  drainAll,
  decodeBody,
  e2eConfig,
  mailhogClear,
  mailhogMessages,
  MAILHOG_URL,
  purgeAllQueues,
  queueDepth,
  sqsClient,
  startWebhookReceiver,
  type WebhookReceiver,
} from './harness';

/**
 * Full-stack end-to-end suite.
 *
 * Real HTTP through the real Nest app, real DynamoDB, real SQS-compatible
 * queues, real SMTP. Nothing here is mocked — the point is to prove the wiring,
 * which a mocked test cannot do.
 *
 * Requires `docker compose up -d`.
 */

const cfg: PulseConfig = e2eConfig();

let app: INestApplication;
let http: ReturnType<typeof request>;
let ctx: PulseContext;
let sqs: SQSClient;
let hook: WebhookReceiver;

let tenant: Tenant;
let apiKey: string;
let subscriberId: string;

/** A second tenant, used only to prove cross-tenant reads are impossible. */
let otherTenantKey: string;
let otherTenantId: string;

const ORDER_TEMPLATE = {
  key: 'order-shipped',
  name: 'Order shipped',
  category: 'transactional',
  locales: {
    en: {
      email: {
        subject: 'Order {{ order.id }} shipped',
        html: '<p>Hi {{ subscriber.name }}, order {{ order.id }} is on its way.</p>',
      },
      push: { title: 'Shipped', body: 'Order {{ order.id }} shipped' },
      sms: { text: 'Order {{ order.id }} shipped' },
      inapp: { title: 'Shipped', body: 'Order {{ order.id }}', deeplink: '/orders/{{ order.id }}' },
      webhook: { event: 'order.shipped', payload: '{"orderId":"{{ order.id }}"}' },
    },
    bn: {
      email: {
        subject: 'অর্ডার {{ order.id }} পাঠানো হয়েছে',
        html: '<p>অর্ডার {{ order.id }} পথে আছে।</p>',
      },
      inapp: { title: 'পাঠানো হয়েছে', body: 'অর্ডার {{ order.id }}' },
    },
  },
};

async function provisionTenant(name: string): Promise<{ tenant: Tenant; key: string }> {
  const t: Tenant = {
    tenantId: newTenantId(),
    name,
    plan: 'growth',
    status: 'active',
    monthlyQuota: 1_000,
    rateLimitPerMin: 10_000,
    retentionDays: 90,
    createdAt: new Date().toISOString(),
  };
  await ctx.repos.tenants.create(t);

  const generated = generateApiKey('pk_test');
  await ctx.repos.apiKeys.create({
    keyHash: generated.hash,
    keyId: newKeyId(),
    tenantId: t.tenantId,
    name: 'e2e',
    prefix: 'pk_test',
    last4: generated.last4,
    scopes: [...SCOPES],
    status: 'active',
    createdAt: new Date().toISOString(),
  });

  return { tenant: t, key: generated.plaintext };
}

beforeAll(async () => {
  // The Nest app reads configuration from process.env at boot.
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PULSE_TABLE: cfg.tableName,
    DYNAMODB_ENDPOINT: cfg.dynamodbEndpoint,
    SQS_ENDPOINT: cfg.sqsEndpoint,
    QUEUE_URL_PREFIX: cfg.queueUrlPrefix,
    AWS_REGION: cfg.region,
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: cfg.emailFrom,
    SMTP_HOST: cfg.smtpHost,
    SMTP_PORT: String(cfg.smtpPort),
    PUSH_PROVIDER: 'log',
    SMS_PROVIDER: 'log',
    LOG_LEVEL: 'silent',
    ADMIN_TOKEN: 'e2e-admin-token-0000000000000000000000',
  });

  await waitForDynamo(cfg);
  await waitForSqs(cfg);
  await waitForMailhog(MAILHOG_URL);

  await dropTable(cfg);
  await createTable(cfg);

  ctx = contextFor(cfg);
  sqs = sqsClient(cfg);
  hook = await startWebhookReceiver();

  const { createApp } = (await import('@pulse/api')) as { createApp: () => Promise<INestApplication> };
  app = await createApp();
  await app.init();
  http = request(app.getHttpServer());

  const primary = await provisionTenant('E2E Primary');
  tenant = primary.tenant;
  apiKey = primary.key;

  const other = await provisionTenant('E2E Other');
  otherTenantId = other.tenant.tenantId;
  otherTenantKey = other.key;

  subscriberId = newSubscriberId();
  const now = new Date().toISOString();
  await ctx.repos.subscribers.put({
    tenantId: tenant.tenantId,
    subscriberId,
    externalId: 'e2e-user-1',
    email: 'e2e@pulse.test',
    phone: '+8801712345678',
    locale: 'en',
    timezone: 'Asia/Dhaka',
    attributes: { name: 'Omer' },
    preferences: { channels: {}, categories: {} },
    topics: ['all-users'],
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.subscribers.addDevice({
    tenantId: tenant.tenantId,
    subscriberId,
    token: 'e2e-device-token',
    platform: 'android',
    createdAt: now,
    lastSeenAt: now,
  });

  // Written through the repository rather than the API: @IsUrl requires a TLD,
  // and the receiver runs on 127.0.0.1.
  await ctx.repos.webhooks.put({
    tenantId: tenant.tenantId,
    endpointId: newEndpointId(),
    url: hook.url,
    secret: 'whsec_e2e_secret',
    events: ['*'],
    status: 'active',
    createdAt: now,
  });

  await http
    .post('/v1/templates')
    .set('Authorization', `Bearer ${apiKey}`)
    .send(ORDER_TEMPLATE)
    .expect(201);
}, 90_000);

beforeEach(async () => {
  await mailhogClear();
  await purgeAllQueues(cfg, sqs);
  hook.hits.length = 0;
});

afterAll(async () => {
  await app?.close();
  await hook?.close();
  await dropTable(cfg);
});

const auth = () => ({ Authorization: `Bearer ${apiKey}` });

describe('health', () => {
  it('reports ok without an API key', async () => {
    const res = await http.get('/healthz').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dynamodb.ok).toBe(true);
  });
});

describe('send → deliver', () => {
  it('fans out to every channel and delivers each one', async () => {
    const accepted = await http
      .post('/v1/notifications')
      .set(auth())
      .send({
        to: { subscriberId },
        templateKey: 'order-shipped',
        data: { order: { id: 'A-1001' } },
      })
      .expect(202);

    const messageId = accepted.body.messageId as string;
    expect(accepted.body.status).toBe('queued');
    expect((accepted.body.channels as string[]).sort()).toEqual([
      'email',
      'inapp',
      'push',
      'sms',
      'webhook',
    ]);

    await drainAll(cfg, sqs);

    // --- the email really left, with both MIME parts ---
    const mail = await mailhogMessages();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('Order A-1001 shipped');
    expect(mail[0]!.to).toBe('e2e@pulse.test');
    expect(decodeBody(mail[0]!.body)).toContain('Hi Omer');
    // multipart/alternative: html + text.
    expect(mail[0]!.partCount).toBeGreaterThanOrEqual(2);

    // --- the webhook arrived and its signature verifies ---
    expect(hook.hits).toHaveLength(1);
    const hit = hook.hits[0]!;
    expect(verifySignature('whsec_e2e_secret', hit.headers['pulse-signature']!, hit.body)).toBe(
      true,
    );
    expect(JSON.parse(hit.body)).toMatchObject({
      event: 'order.shipped',
      data: { orderId: 'A-1001' },
    });

    // --- the in-app row landed ---
    const inbox = await http
      .get('/v1/inbox')
      .query({ subscriberId })
      .set(auth())
      .expect(200);
    expect(inbox.body.unreadCount).toBe(1);
    expect(inbox.body.data[0]).toMatchObject({
      title: 'Shipped',
      body: 'Order A-1001',
      deeplink: '/orders/A-1001',
    });

    // --- the message rolled up to delivered with an attempt per channel ---
    const final = await http.get(`/v1/notifications/${messageId}`).set(auth()).expect(200);
    expect(final.body.status).toBe('delivered');
    for (const channel of ['email', 'push', 'sms', 'inapp', 'webhook']) {
      expect(final.body.results[channel].status).toBe('delivered');
    }
    expect(final.body.attempts).toHaveLength(5);
  });

  it('renders the bn locale and falls back to en per-channel', async () => {
    const accepted = await http
      .post('/v1/notifications')
      .set(auth())
      .send({
        to: { subscriberId },
        templateKey: 'order-shipped',
        locale: 'bn',
        channels: ['email', 'sms'],
        data: { order: { id: 'B-2002' } },
      })
      .expect(202);

    await drainAll(cfg, sqs);

    const mail = await mailhogMessages();
    expect(mail[0]!.subject).toBe('অর্ডার B-2002 পাঠানো হয়েছে');

    // `bn` defines no sms body, so it falls back to `en` rather than dropping
    // the channel.
    const final = await http
      .get(`/v1/notifications/${accepted.body.messageId as string}`)
      .set(auth())
      .expect(200);
    expect(final.body.results.sms.status).toBe('delivered');
    expect(final.body.rendered.sms.text).toBe('Order B-2002 shipped');
  });

  it('skips a channel the template does not define instead of failing', async () => {
    const accepted = await http
      .post('/v1/notifications')
      .set(auth())
      .send({
        to: { subscriberId },
        content: { sms: { text: 'sms only' } },
        channels: ['sms', 'push'],
      })
      .expect(202);

    await drainAll(cfg, sqs);

    const final = await http
      .get(`/v1/notifications/${accepted.body.messageId as string}`)
      .set(auth())
      .expect(200);
    expect(final.body.results.sms.status).toBe('delivered');
    expect(final.body.results.push.status).toBe('skipped');
    // A skipped channel is settled, not failed — the message still succeeded.
    expect(final.body.status).toBe('delivered');
  });
});

describe('idempotency', () => {
  it('replays the original response and sends nothing the second time', async () => {
    const body = {
      to: { subscriberId },
      templateKey: 'order-shipped',
      channels: ['email'],
      data: { order: { id: 'IDEM-1' } },
    };

    const first = await http
      .post('/v1/notifications')
      .set(auth())
      .set('Idempotency-Key', 'e2e-idem-1')
      .send(body)
      .expect(202);

    const second = await http
      .post('/v1/notifications')
      .set(auth())
      .set('Idempotency-Key', 'e2e-idem-1')
      .send(body)
      .expect(202);

    expect(second.body.messageId).toBe(first.body.messageId);
    expect(second.headers['idempotent-replay']).toBe('true');

    await drainAll(cfg, sqs);
    // One message, not two.
    expect(await mailhogMessages()).toHaveLength(1);
  });

  it('rejects the same key used with a different body', async () => {
    await http
      .post('/v1/notifications')
      .set(auth())
      .set('Idempotency-Key', 'e2e-idem-2')
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['email'], data: { order: { id: 'X' } } })
      .expect(202);

    const conflict = await http
      .post('/v1/notifications')
      .set(auth())
      .set('Idempotency-Key', 'e2e-idem-2')
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['email'], data: { order: { id: 'DIFFERENT' } } })
      .expect(409);

    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('tenant isolation', () => {
  it('will not let another tenant read a message by id', async () => {
    const accepted = await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['email'], data: { order: { id: 'SECRET' } } })
      .expect(202);

    const messageId = accepted.body.messageId as string;

    // The owner can read it.
    await http.get(`/v1/notifications/${messageId}`).set(auth()).expect(200);

    // Knowing the id is not enough.
    const denied = await http
      .get(`/v1/notifications/${messageId}`)
      .set('Authorization', `Bearer ${otherTenantKey}`)
      .expect(404);
    expect(denied.body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('keeps delivery logs separate', async () => {
    const mine = await http.get('/v1/notifications').set(auth()).expect(200);
    const theirs = await http
      .get('/v1/notifications')
      .set('Authorization', `Bearer ${otherTenantKey}`)
      .expect(200);

    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(theirs.body.data).toHaveLength(0);
    expect(otherTenantId).not.toBe(tenant.tenantId);
  });

  it('will not let another tenant read a template', async () => {
    const denied = await http
      .get('/v1/templates/order-shipped')
      .set('Authorization', `Bearer ${otherTenantKey}`)
      .expect(404);
    expect(denied.body.error.code).toBe('TEMPLATE_NOT_FOUND');
  });
});

describe('auth', () => {
  it('rejects a missing key', async () => {
    const res = await http.post('/v1/notifications').send({}).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unknown key', async () => {
    const res = await http
      .get('/v1/usage')
      .set('Authorization', 'Bearer pk_test_not_a_real_key')
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_API_KEY');
  });

  it('rejects a revoked key', async () => {
    const generated = generateApiKey('pk_test');
    await ctx.repos.apiKeys.create({
      keyHash: generated.hash,
      keyId: newKeyId(),
      tenantId: tenant.tenantId,
      name: 'revoked',
      prefix: 'pk_test',
      last4: generated.last4,
      scopes: [...SCOPES],
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    await ctx.repos.apiKeys.revoke(generated.hash);

    const res = await http
      .get('/v1/usage')
      .set('Authorization', `Bearer ${generated.plaintext}`)
      .expect(401);
    expect(res.body.error.code).toBe('KEY_REVOKED');
  });

  it('enforces scopes', async () => {
    const generated = generateApiKey('pk_test');
    await ctx.repos.apiKeys.create({
      keyHash: generated.hash,
      keyId: newKeyId(),
      tenantId: tenant.tenantId,
      name: 'read only',
      prefix: 'pk_test',
      last4: generated.last4,
      scopes: ['notifications:read'],
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    const res = await http
      .post('/v1/notifications')
      .set('Authorization', `Bearer ${generated.plaintext}`)
      .send({ to: { subscriberId }, templateKey: 'order-shipped' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN_SCOPE');
  });
});

describe('preferences and suppression', () => {
  it('suppresses a channel the subscriber opted out of', async () => {
    await http
      .put(`/v1/subscribers/${subscriberId}/preferences`)
      .set(auth())
      .send({ channels: { email: false } })
      .expect(200);

    const accepted = await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['email', 'sms'], data: { order: { id: 'OPT' } } })
      .expect(202);

    await drainAll(cfg, sqs);

    const final = await http
      .get(`/v1/notifications/${accepted.body.messageId as string}`)
      .set(auth())
      .expect(200);
    expect(final.body.results.email.status).toBe('suppressed');
    expect(final.body.results.sms.status).toBe('delivered');
    // Nothing was handed to the provider.
    expect(await mailhogMessages()).toHaveLength(0);

    // Restore for later tests.
    await http
      .put(`/v1/subscribers/${subscriberId}/preferences`)
      .set(auth())
      .send({ channels: { email: true } })
      .expect(200);
  });

  it('skips an address on the suppression list', async () => {
    await ctx.repos.suppression.add({
      tenantId: tenant.tenantId,
      channel: 'email',
      // Deliberately different casing: suppression must be case-insensitive.
      address: 'E2E@PULSE.TEST',
      reason: 'bounce',
      createdAt: new Date().toISOString(),
    });

    const accepted = await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['email'], data: { order: { id: 'SUP' } } })
      .expect(202);

    await drainAll(cfg, sqs);

    const final = await http
      .get(`/v1/notifications/${accepted.body.messageId as string}`)
      .set(auth())
      .expect(200);
    expect(final.body.results.email.status).toBe('suppressed');
    expect(await mailhogMessages()).toHaveLength(0);

    await ctx.repos.suppression.remove(tenant.tenantId, 'email', 'e2e@pulse.test');
  });
});

describe('retries and the DLQ', () => {
  it('retries a 500 from a webhook receiver and DLQs it after 3 attempts', async () => {
    // Fail every attempt: 3 receives, then redrive.
    hook.failWith(500, 10);

    await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['webhook'], data: { order: { id: 'DLQ-1' } } })
      .expect(202);

    // Drain until the queue stops handing it back. The exact receive on which
    // redrive fires is a broker detail; what matters is that retries are
    // bounded and the message ends up in the DLQ rather than looping forever.
    let attempts = 0;
    for (let round = 0; round < 6; round++) {
      const result = await drain(cfg, sqs, 'webhook');
      if (result.processed === 0) break;
      attempts += result.retried;
    }

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(3);
    expect(await queueDepth(sqs, queueUrl(cfg, 'webhook'))).toBe(0);
    expect(await queueDepth(sqs, `${queueUrl(cfg, 'webhook')}-dlq`)).toBe(1);
  });

  it('does not retry a 4xx — it will fail the same way forever', async () => {
    hook.failWith(400, 10);

    const accepted = await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['webhook'], data: { order: { id: 'NO-RETRY' } } })
      .expect(202);

    const result = await drain(cfg, sqs, 'webhook');
    expect(result.retried).toBe(0);

    const final = await http
      .get(`/v1/notifications/${accepted.body.messageId as string}`)
      .set(auth())
      .expect(200);
    expect(final.body.results.webhook.status).toBe('failed');
    expect(final.body.status).toBe('failed');
  });
});

describe('scheduling', () => {
  it('rejects a send scheduled in the past', async () => {
    const res = await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['sms'], sendAt: '2020-01-01T00:00:00Z' })
      .expect(422);
    expect(res.body.error.code).toBe('SCHEDULE_IN_PAST');
  });

  it('parks a far-future send in the due queue and cancels it before it fires', async () => {
    const sendAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const accepted = await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['sms'], sendAt, data: { order: { id: 'SCHED' } } })
      .expect(202);

    const messageId = accepted.body.messageId as string;
    expect(accepted.body.status).toBe('scheduled');
    // Beyond the 15-minute SQS window, so nothing is on the queue yet.
    expect(await queueDepth(sqs, queueUrl(cfg, 'sms'))).toBe(0);
    // It is in the due queue, just not due.
    expect(await ctx.repos.messages.listDueScheduled(new Date())).toHaveLength(0);
    expect(
      (await ctx.repos.messages.listDueScheduled(new Date(Date.now() + 3 * 3_600_000))).map(
        (m) => m.messageId,
      ),
    ).toContain(messageId);

    const cancelled = await http
      .post(`/v1/notifications/${messageId}/cancel`)
      .set(auth())
      .expect(201);
    expect(cancelled.body.status).toBe('cancelled');
  });

  it('delivers a near-future send through the SQS delay window', async () => {
    const sendAt = new Date(Date.now() + 1_000).toISOString();
    const accepted = await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { subscriberId }, templateKey: 'order-shipped', channels: ['sms'], sendAt, data: { order: { id: 'SOON' } } })
      .expect(202);

    await new Promise((r) => setTimeout(r, 2_000));
    await drain(cfg, sqs, 'sms');

    const final = await http
      .get(`/v1/notifications/${accepted.body.messageId as string}`)
      .set(auth())
      .expect(200);
    expect(final.body.results.sms.status).toBe('delivered');
  });
});

describe('quota', () => {
  it('rejects a send past the monthly quota', async () => {
    const capped = await provisionTenant('Capped');
    await ctx.repos.tenants.put({ ...capped.tenant, monthlyQuota: 1 });

    const send = () =>
      http
        .post('/v1/notifications')
        .set('Authorization', `Bearer ${capped.key}`)
        .send({ to: { email: 'someone@example.com' }, content: { email: { subject: 's', html: '<p>h</p>' } }, channels: ['email'] });

    await send().expect(202);
    const rejected = await send().expect(429);
    expect(rejected.body.error.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('validation', () => {
  it('returns a VALIDATION_FAILED envelope with details', async () => {
    const res = await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { email: 'not-an-email' }, templateKey: 'order-shipped' })
      .expect(422);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('requires a template or inline content', async () => {
    const res = await http.post('/v1/notifications').set(auth()).send({ to: { subscriberId } }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('404s an unknown template with a stable code', async () => {
    const res = await http
      .post('/v1/notifications')
      .set(auth())
      .send({ to: { subscriberId }, templateKey: 'does-not-exist' })
      .expect(404);
    expect(res.body.error.code).toBe('TEMPLATE_NOT_FOUND');
  });
});

describe('templates are immutable', () => {
  it('publishing an edit creates a new version and leaves the old readable', async () => {
    const v1 = await http
      .post('/v1/templates')
      .set(auth())
      .send({ key: 'versioned', name: 'V', locales: { en: { sms: { text: 'first' } } } })
      .expect(201);

    const v2 = await http
      .put('/v1/templates/versioned')
      .set(auth())
      .send({ key: 'versioned', name: 'V', locales: { en: { sms: { text: 'second' } } } })
      .expect(200);

    expect(v1.body.version).toBe(1);
    expect(v2.body.version).toBe(2);

    const latest = await http.get('/v1/templates/versioned').set(auth()).expect(200);
    expect(latest.body.locales.en.sms.text).toBe('second');

    const old = await http.get('/v1/templates/versioned').query({ version: 1 }).set(auth()).expect(200);
    expect(old.body.locales.en.sms.text).toBe('first');
  });
});

describe('admin provisioning', () => {
  const adminAuth = { Authorization: 'Bearer e2e-admin-token-0000000000000000000000' };

  it('creates a tenant and issues a working key', async () => {
    const created = await http
      .post('/admin/v1/tenants')
      .set(adminAuth)
      .send({ name: 'Provisioned Co', plan: 'free' })
      .expect(201);

    const issued = await http
      .post(`/admin/v1/tenants/${created.body.tenantId as string}/keys`)
      .set(adminAuth)
      .send({ name: 'primary' })
      .expect(201);

    expect(issued.body.key).toMatch(/^pk_live_[0-9a-f]{64}$/);
    // The hash must never be echoed back.
    expect(issued.body.keyHash).toBeUndefined();

    const usage = await http
      .get('/v1/usage')
      .set('Authorization', `Bearer ${issued.body.key as string}`)
      .expect(200);
    expect(usage.body.plan).toBe('free');
  });

  it('rejects the admin surface without the admin token', async () => {
    await http.post('/admin/v1/tenants').set(auth()).send({ name: 'nope' }).expect(401);
  });

  it('blocks a suspended tenant', async () => {
    const victim = await provisionTenant('To Suspend');
    await http
      .post(`/admin/v1/tenants/${victim.tenant.tenantId}/suspend`)
      .set(adminAuth)
      .expect(201);

    const res = await http
      .get('/v1/usage')
      .set('Authorization', `Bearer ${victim.key}`)
      .expect(403);
    expect(res.body.error.code).toBe('TENANT_SUSPENDED');
  });
});
