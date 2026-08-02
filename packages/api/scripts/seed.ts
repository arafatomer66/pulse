import {
  createContext,
  ensureTable,
  hashApiKey,
  loadConfig,
  newEndpointId,
  newKeyId,
  SCOPES,
  waitForDynamo,
  type Template,
} from '@pulse/core';

/**
 * Local seed. Idempotent — safe to re-run.
 *
 * The demo API key is deterministic so it can be pasted into a README, a REST
 * client and the e2e suite without changing on every run. That is a local-only
 * convenience: real keys are random and only their hash is stored.
 */
const DEMO_TENANT_ID = 'ten_demo000000000000000000';
const DEMO_API_KEY = 'pk_test_00000000000000000000000000000000000000000000000000000000demo';
const DEMO_SUBSCRIBER_ID = 'sub_demo000000000000000000';

const ORDER_SHIPPED: Template['locales'] = {
  en: {
    email: {
      subject: 'Your order {{ order.id }} is on its way',
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px">
  <h2 style="margin:0 0 12px">On its way</h2>
  <p>Hi {{ subscriber.name | default: "there" }},</p>
  <p>Order <strong>{{ order.id }}</strong> shipped and should arrive by {{ order.eta }}.</p>
  <p><a href="https://example.com/orders/{{ order.id }}">Track your order</a></p>
</div>`,
    },
    push: { title: 'Order shipped', body: 'Order {{ order.id }} is on its way' },
    sms: { text: 'Your order {{ order.id }} has shipped. Track: example.com/o/{{ order.id }}' },
    inapp: {
      title: 'Order shipped',
      body: 'Order {{ order.id }} is on its way',
      deeplink: '/orders/{{ order.id }}',
    },
    webhook: { event: 'order.shipped', payload: '{"orderId":"{{ order.id }}"}' },
  },
  bn: {
    email: {
      subject: 'আপনার অর্ডার {{ order.id }} পাঠানো হয়েছে',
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px">
  <h2 style="margin:0 0 12px">পথে আছে</h2>
  <p>প্রিয় {{ subscriber.name | default: "গ্রাহক" }},</p>
  <p>অর্ডার <strong>{{ order.id }}</strong> পাঠানো হয়েছে, {{ order.eta }} তারিখে পৌঁছাবে।</p>
</div>`,
    },
    push: { title: 'অর্ডার পাঠানো হয়েছে', body: 'অর্ডার {{ order.id }} পথে আছে' },
    sms: { text: 'আপনার অর্ডার {{ order.id }} পাঠানো হয়েছে।' },
    inapp: {
      title: 'অর্ডার পাঠানো হয়েছে',
      body: 'অর্ডার {{ order.id }} পথে আছে',
      deeplink: '/orders/{{ order.id }}',
    },
  },
};

const OTP: Template['locales'] = {
  en: { sms: { text: 'Your verification code is {{ code }}. It expires in 5 minutes.' } },
  bn: { sms: { text: 'আপনার ভেরিফিকেশন কোড {{ code }}। ৫ মিনিটে মেয়াদ শেষ।' } },
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`seeding ${cfg.tableName} at ${cfg.dynamodbEndpoint ?? 'AWS'}`);

  await waitForDynamo(cfg);
  await ensureTable(cfg);

  const ctx = createContext(cfg);
  const now = new Date().toISOString();

  // --- tenant -----------------------------------------------------------
  const existingTenant = await ctx.repos.tenants.get(DEMO_TENANT_ID);
  if (!existingTenant) {
    await ctx.repos.tenants.create({
      tenantId: DEMO_TENANT_ID,
      name: 'Demo Co',
      plan: 'growth',
      status: 'active',
      monthlyQuota: cfg.defaultMonthlyQuota,
      rateLimitPerMin: cfg.defaultRateLimitPerMin,
      retentionDays: cfg.messageRetentionDays,
      createdAt: now,
    });
    console.log(`  + tenant ${DEMO_TENANT_ID}`);
  } else {
    console.log(`  = tenant ${DEMO_TENANT_ID} (exists)`);
  }

  // --- api key ----------------------------------------------------------
  const keyHash = hashApiKey(DEMO_API_KEY);
  if (!(await ctx.repos.apiKeys.findByHash(keyHash))) {
    await ctx.repos.apiKeys.create({
      keyHash,
      keyId: newKeyId(),
      tenantId: DEMO_TENANT_ID,
      name: 'local dev',
      prefix: 'pk_test',
      last4: DEMO_API_KEY.slice(-4),
      scopes: [...SCOPES],
      status: 'active',
      createdAt: now,
    });
    console.log('  + api key');
  } else {
    console.log('  = api key (exists)');
  }

  // --- templates --------------------------------------------------------
  for (const [key, name, category, locales] of [
    ['order-shipped', 'Order shipped', 'transactional', ORDER_SHIPPED],
    ['otp', 'One-time passcode', 'security', OTP],
  ] as const) {
    const latest = await ctx.repos.templates.getLatest(DEMO_TENANT_ID, key);
    if (!latest) {
      await ctx.repos.templates.publish({
        tenantId: DEMO_TENANT_ID,
        key,
        name,
        category,
        locales,
      });
      console.log(`  + template ${key}`);
    } else {
      console.log(`  = template ${key} v${latest.version} (exists)`);
    }
  }

  // --- subscriber -------------------------------------------------------
  if (!(await ctx.repos.subscribers.get(DEMO_TENANT_ID, DEMO_SUBSCRIBER_ID))) {
    await ctx.repos.subscribers.put({
      tenantId: DEMO_TENANT_ID,
      subscriberId: DEMO_SUBSCRIBER_ID,
      externalId: 'demo-user-1',
      email: 'demo@pulse.local',
      phone: '+8801712345678',
      locale: 'en',
      timezone: 'Asia/Dhaka',
      attributes: { name: 'Omer' },
      preferences: { channels: {}, categories: {} },
      topics: ['all-users'],
      createdAt: now,
      updatedAt: now,
    });
    console.log(`  + subscriber ${DEMO_SUBSCRIBER_ID}`);

    await ctx.repos.subscribers.addDevice({
      tenantId: DEMO_TENANT_ID,
      subscriberId: DEMO_SUBSCRIBER_ID,
      token: 'demo-fcm-token',
      platform: 'android',
      createdAt: now,
      lastSeenAt: now,
    });
  } else {
    console.log(`  = subscriber ${DEMO_SUBSCRIBER_ID} (exists)`);
  }

  // --- webhook endpoint -------------------------------------------------
  const hooks = await ctx.repos.webhooks.list(DEMO_TENANT_ID);
  if (hooks.length === 0) {
    await ctx.repos.webhooks.put({
      tenantId: DEMO_TENANT_ID,
      endpointId: newEndpointId(),
      url: 'https://example.com/pulse-hook',
      secret: 'whsec_demo_secret_do_not_use_in_production',
      events: ['*'],
      status: 'active',
      createdAt: now,
    });
    console.log('  + webhook endpoint');
  } else {
    console.log('  = webhook endpoint (exists)');
  }

  console.log(`
seed complete.

  tenant     ${DEMO_TENANT_ID}
  subscriber ${DEMO_SUBSCRIBER_ID}
  api key    ${DEMO_API_KEY}

  curl -s localhost:3100/v1/notifications \\
    -H "Authorization: Bearer ${DEMO_API_KEY}" \\
    -H 'content-type: application/json' \\
    -d '{"to":{"subscriberId":"${DEMO_SUBSCRIBER_ID}"},"templateKey":"order-shipped","data":{"order":{"id":"A-1001","eta":"Sunday"}}}'
`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});

export { DEMO_API_KEY, DEMO_SUBSCRIBER_ID, DEMO_TENANT_ID };
