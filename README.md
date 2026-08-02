# Pulse

**Send a notification with one HTTP call. Pulse handles the rest.**

Email, mobile push, SMS, an in-app inbox and outbound webhooks — behind a single
API. It renders your template in the recipient's language, respects their
opt-outs, retries what fails, and logs every attempt.

```bash
curl -X POST $PULSE/v1/notifications \
  -H "Authorization: Bearer $YOUR_KEY" \
  -d '{ "to": { "externalId": "user-42" },
        "templateKey": "order-shipped",
        "data": { "order": { "id": "A-1001", "eta": "Sunday" } } }'
```

That one call just sent an email, a push notification, an SMS and an in-app
message — in Bengali if that's the user's language, skipping any channel they've
unsubscribed from.

> **You run Pulse yourself.** There's no signup, no account, and no API key to
> get from anyone. You deploy it and mint your own keys. It's your service.

---

## Contents

[Why](#why) · [Quick start](#quick-start) · [The console](#the-console) ·
[Core ideas](#core-ideas) · [Templates](#templates) · [Sending](#sending) ·
[Reading results](#reading-results) · [Preferences & bounces](#preferences--bounces) ·
[In your app](#in-your-app) · [API reference](#api-reference) ·
[Deploying](#deploying) · [How it's built](#how-its-built)

---

## Why

Every project ends up rebuilding the same thing: an email sender, then a push
sender, then retry logic, then a way to stop mailing people who unsubscribed,
then templates, then translations, then a log so support can answer "did they
get it?"

Pulse is that, once. Point every project at it. Each gets its own API key,
templates and data, completely isolated from the others.

| | |
|---|---|
| **Five channels** | email · push · SMS · in-app inbox · webhooks |
| **One template, all channels** | Write the email, push, SMS and in-app copy in one document |
| **Two languages built in** | English and Bengali, with per-channel fallback |
| **Opt-outs that just work** | Someone unsubscribes once; every future send respects it, with no code change |
| **Bounce protection** | Bad addresses are suppressed automatically — this is what keeps your email deliverable |
| **Safe retries** | Send the same request twice, it delivers once |
| **Scheduling** | Send later, cancel any time before it goes |
| **A real delivery log** | Every message, channel, attempt and provider error |

---

## Quick start

You need **Node 24+**, **pnpm 11+** and **Docker**.

```bash
git clone https://github.com/arafatomer66/pulse.git
cd pulse

pnpm install
docker compose up -d      # local stand-ins for DynamoDB, SQS and email
cp .env.example .env
pnpm build
pnpm seed                 # creates a demo account, a user and two templates
pnpm dev                  # starts the API and the delivery workers
```

Now open **<http://localhost:3100/console>** — it signs itself in.

> **`pnpm dev` starts two things**: the API that accepts messages, and the
> workers that deliver them. If a message stays at `queued` forever, the workers
> aren't running.

### Send your first notification

1. Open the console, go to the **Send** tab
2. Leave *Recipient by* on `Subscriber ID`, paste `sub_demo000000000000000000`
3. Pick the `order-shipped` template, leave everything else alone
4. Press **Send**

About two seconds later you'll see a result per channel. Open
<http://localhost:8125> to read the email that actually left.

That's a real multi-channel notification, sent.

---

## The console

`http://localhost:3100/console` — a full operator UI, no build step.

| Tab | For |
|---|---|
| **Send** | Compose and fire a message; watch per-channel results land |
| **Delivery log** | Every message ever sent. Click one for channel detail, the exact rendered content, and every attempt |
| **Templates** | See what exists; publish new ones |
| **Subscribers** | Add people, look them up, see their preferences and devices |
| **Inbox** | What your app's notification bell would show one person |
| **Usage** | Messages sent this month against the quota |

Use it to operate and debug. Your app talks to the API directly.

---

## Core ideas

Four nouns. Once these land, the rest of the API is predictable.

### Tenant — one per project

ShareDeal is a tenant, DevAdda is another. Each has its own templates,
subscribers, quota and log, and **cannot see any other tenant's data**.

Tenants are created with the admin token, not an API key:

```bash
curl -X POST $PULSE/admin/v1/tenants \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"ShareDeal Social","plan":"growth"}'
```

### API key — how a project authenticates

```bash
curl -X POST $PULSE/admin/v1/tenants/$TENANT_ID/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"production"}'
# → { "key": "pk_live_fa059e9a…",
#     "warning": "Store this key now — it is not recoverable." }
```

Only a hash is stored, so the key is shown **once** and can never be retrieved —
lose it and you issue a new one. You generate these yourself; nothing is fetched
from any third party.

### Subscriber — a person who receives things

Their email, phone, language, devices and opt-outs. The field that matters is
`externalId` — **your own user ID**:

```bash
curl -X POST $PULSE/v1/subscribers -H "Authorization: Bearer $KEY" -d '{
  "externalId": "sd-user-8821",
  "email": "omer@example.com",
  "phone": "01712345678",
  "locale": "bn",
  "attributes": { "name": "Omer" }
}'
```

Set it once, then address people by the ID your database already uses — you never
store a Pulse ID anywhere. Bangladeshi phone formats are normalised to
`+8801712345678` automatically.

### Template — what to say, everywhere

One document covering every channel and language. See [Templates](#templates).

### The five channels

| Channel | Needs | Delivered by |
|---|---|---|
| `email` | An email address | AWS SES, **or any SMTP server** |
| `push` | A registered device token | Firebase — covers Android, iOS and web |
| `sms` | A phone number | BulkSMS BD, or AWS SNS |
| `inapp` | Nothing but the subscriber | Pulse itself; your app reads the feed |
| `webhook` | A registered endpoint | A signed HTTPS POST to you |

**You rarely name channels.** Omit them and Pulse uses every channel the template
defines and the person can actually receive on.

---

## Templates

```json
{
  "key": "order-shipped",
  "name": "Order shipped",
  "category": "transactional",
  "locales": {
    "en": {
      "email": {
        "subject": "Order {{ order.id }} is on its way",
        "html": "<p>Hi {{ subscriber.name }}, arriving {{ order.eta }}.</p>"
      },
      "push":  { "title": "On its way", "body": "Order {{ order.id }}" },
      "sms":   { "text": "Order {{ order.id }} shipped. Arriving {{ order.eta }}." },
      "inapp": { "title": "Shipped", "body": "Order {{ order.id }}",
                 "deeplink": "/orders/{{ order.id }}" }
    },
    "bn": {
      "email": { "subject": "অর্ডার {{ order.id }} পাঠানো হয়েছে",
                 "html": "<p>পথে আছে।</p>" },
      "push":  { "title": "পাঠানো হয়েছে", "body": "অর্ডার {{ order.id }}" }
    }
  }
}
```

Text is [Liquid](https://liquidjs.com) — `{{ order.id }}` pulls from the `data`
you send. It's sandboxed, so a template can't execute code.

**Three rules:**

- **English is the fallback.** `locales.en` is required. Above, Bengali defines
  no `sms` — so a Bengali user still gets the English SMS rather than silence.
- **A missing channel is skipped, not an error.** There's no `webhook` above; ask
  for webhook anyway and it returns `skipped` while everything else delivers.
- **Editing publishes a new version.** Old versions stay readable, and a message
  already accepted keeps the wording it was accepted with — an edit can never
  rewrite something already in flight.

**You never pass a language.** It comes from the subscriber's `locale`. Pass
`locale` on a send only to override that.

---

## Sending

### The everyday case

```json
{ "to": { "externalId": "sd-user-8821" },
  "templateKey": "order-shipped",
  "data": { "order": { "id": "A-1001", "eta": "Sunday" } } }
```

### A one-time passcode — SMS only

Never let an OTP fan out to email.

```json
{ "to": { "externalId": "sd-user-8821" },
  "templateKey": "otp",
  "channels": ["sms"],
  "data": { "code": "4821" } }
```

### Later, and cancellable

```json
{ "to": { "externalId": "sd-user-8821" },
  "templateKey": "cart-reminder",
  "sendAt": "2026-08-03T09:00:00Z" }
```

```
POST /v1/notifications/{messageId}/cancel
```

### Everyone on a topic

```
POST /v1/topics/dhaka-buyers/broadcast
Idempotency-Key: launch-announce-v1

{ "templateKey": "new-feature", "channels": ["inapp", "push"] }
```

### A one-off with no template

Note `to.email` — no stored subscriber needed.

```json
{ "to": { "email": "someone@example.com" },
  "channels": ["email"],
  "content": { "email": { "subject": "Your invoice",
                          "html": "<p>Attached.</p>" } } }
```

### Always send an Idempotency-Key

Use an ID from your own domain:

```
Idempotency-Key: order-1001-shipped
```

Retry the same call and Pulse returns the original result and **sends nothing**.
Without it, a retried job or a double-tapped button sends twice.

---

## Reading results

`POST` returns immediately with a `messageId` and `status: "queued"` — accepted,
not yet delivered. Fetch the message to see what happened:

```
GET /v1/notifications/{messageId}
```

### Per channel

| Status | What happened | Act? |
|---|---|---|
| `delivered` | The provider accepted it | No |
| `suppressed` | They opted out, or the address previously hard-bounced. Deliberately not sent | **No — this is correct** |
| `skipped` | Nothing to send on — no phone, no device, no template body | Only if you expected otherwise |
| `failed` | Rejected after retries | Yes — read `error` |

### The whole message

| Status | Means |
|---|---|
| `queued` | Accepted, heading to the workers |
| `scheduled` | Waiting for its time. Still cancellable |
| `processing` | Some channels reported, others haven't |
| `delivered` | Nothing failed |
| `partial` | Some landed, some failed |
| `failed` | Everything failed |
| `cancelled` | You cancelled it in time |

> A message where every channel was `suppressed` reports **`delivered`**. Pulse
> did exactly what the person's preferences asked — that's success, not failure.

---

## Preferences & bounces

### Someone unsubscribes

```
POST /v1/subscribers/{id}/unsubscribe
{ "channel": "email" }
```

Every future send skips email for them. You add no checks anywhere in your code.

Finer control — marketing off, receipts on:

```
PUT /v1/subscribers/{id}/preferences
{ "categories": { "marketing": false, "transactional": true } }
```

### An address goes bad

When a mailbox permanently rejects mail, or someone marks a message as spam, the
address goes on a suppression list. Every later send to it returns `suppressed`
without touching the provider.

> **This is not optional.** AWS measures your bounce and complaint rates. Cross
> roughly 5% bounces or 0.1% complaints and they throttle or suspend your ability
> to send email *at all*.

Temporary problems — a full mailbox, a DNS blip — are deliberately **not**
suppressed. Those clear up, and cutting someone off permanently over an afternoon
would be wrong.

---

## In your app

### NestJS / Node — write this once

```ts
@Injectable()
export class PulseService {
  private readonly base = process.env.PULSE_URL!;
  private readonly key = process.env.PULSE_API_KEY!;

  async notify(input: {
    userId: string;
    templateKey: string;
    data: Record<string, unknown>;
    channels?: string[];
    idempotencyKey?: string;
  }) {
    const res = await fetch(`${this.base}/v1/notifications`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.key}`,
        'content-type': 'application/json',
        ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        to: { externalId: input.userId },
        templateKey: input.templateKey,
        channels: input.channels,
        data: input.data,
      }),
    });
    if (!res.ok) throw new Error(`pulse ${res.status}: ${await res.text()}`);
    return res.json();
  }
}
```

Every call site becomes one line:

```ts
await this.pulse.notify({
  userId: buyer.id,
  templateKey: 'order-shipped',
  data: { order },
  idempotencyKey: `order-${order.id}-shipped`,
});
```

### Flutter — two things to wire

```dart
// 1 — on login, register the device so push can reach them
await dio.post('/v1/subscribers/$subscriberId/devices', data: {
  'token': await FirebaseMessaging.instance.getToken(),
  'platform': Platform.isIOS ? 'ios' : 'android',
});

// 2 — the notification bell
final res = await dio.get('/v1/inbox',
    queryParameters: {'subscriberId': subscriberId});

res.data['unreadCount'];   // the badge
res.data['data'];          // title, body, deeplink, readAt — newest first

await dio.post('/v1/inbox/$itemId/read',
    queryParameters: {'subscriberId': subscriberId});
```

### Errors

Always the same shape. Switch on `code` — that's the part that stays stable.

```json
{ "error": { "code": "TEMPLATE_NOT_FOUND", "message": "no template 'welcome'" } }
```

| Code | Means |
|---|---|
| `INVALID_API_KEY` | Key unknown or revoked |
| `FORBIDDEN_SCOPE` | Key lacks a permission |
| `VALIDATION_FAILED` | Bad body — `details` lists the fields |
| `TEMPLATE_NOT_FOUND` | No template by that key for this tenant |
| `QUOTA_EXCEEDED` | Monthly limit hit |
| `RATE_LIMITED` | Too many requests this minute |
| `SCHEDULE_IN_PAST` | `sendAt` already passed |
| `IDEMPOTENCY_KEY_REUSED` | Same key, different body |

---

## API reference

Full OpenAPI 3.1 spec: [`docs/openapi.yaml`](docs/openapi.yaml)

```
POST   /v1/notifications                  send (or schedule)
GET    /v1/notifications                  delivery log
GET    /v1/notifications/:id              status + per-channel detail + attempts
POST   /v1/notifications/:id/cancel       cancel a scheduled send
POST   /v1/topics/:topic/broadcast        fan out to a topic

POST   /v1/subscribers                    create or update
GET    /v1/subscribers/:id
PUT    /v1/subscribers/:id/preferences    channel & category opt-outs
POST   /v1/subscribers/:id/unsubscribe    one-click
POST   /v1/subscribers/:id/devices        register a push token
DELETE /v1/subscribers/:id/devices/:token

GET|POST|PUT /v1/templates[/:key]         list, publish, fetch a version
GET    /v1/inbox?subscriberId=…           in-app feed + unread count
POST   /v1/inbox/:id/read
GET|POST|DELETE /v1/webhooks              outbound endpoints
GET    /v1/usage                          this period vs. the plan
GET    /healthz                           public

POST   /admin/v1/tenants                  admin token, not an API key
POST   /admin/v1/tenants/:id/keys
POST   /admin/v1/tenants/:id/suspend
```

---

## Deploying

Two independent tracks — you don't need both, or either, to start.

**Email today, no AWS.** Point `EMAIL_PROVIDER=smtp` at any SMTP host — Postmark,
Resend, Brevo:

```env
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
```

**Email on SES.** Cheaper at volume ($0.10 per thousand), but you must verify a
domain and ask AWS to lift the sandbox — usually 24–48 hours.

### To AWS

```bash
aws configure                        # your own account
cd infra
pnpm cdk bootstrap                   # once per account/region
pnpm cdk deploy --all -c env=dev     # dev sends nothing — a safe first run
```

Full sequence including SES setup:
**[`docs/runbooks/deploy.md`](docs/runbooks/deploy.md)**
When something lands in a dead-letter queue:
**[`docs/runbooks/dlq-replay.md`](docs/runbooks/dlq-replay.md)**

### Checklist

- [ ] `ADMIN_TOKEN` — 32+ random characters. Production won't boot without one
- [ ] Email — an SMTP provider, or a verified SES domain with SPF, DKIM and DMARC
- [ ] Push — a Firebase project and its service-account JSON (covers iOS too)
- [ ] SMS — a BulkSMS BD key. Roughly 1/100th of AWS SNS for Bangladesh
- [ ] Bounce handling — connect SES feedback to the topic the deploy creates
- [ ] One tenant per project, so revoking one key doesn't affect the others

### Cost

**~$0.40/month idle** — nothing runs when nobody sends. About **$17/month** of
infrastructure at a million notifications. Delivery is the real cost: SES is
$0.10 per thousand, and SMS dominates everything at volume. Full breakdown in
[`docs/COSTS.md`](docs/COSTS.md).

---

## How it's built

```
API Gateway → Lambda (NestJS) → SQS per channel → worker Lambdas → providers
                    ↓                  ↓                 ↓
        DynamoDB (one table, 3 indexes)         dead-letter queues
```

Rendering happens when a message is accepted, not when it's delivered — so a
template error is an immediate `422`, and editing a template can't change a
message already in flight.

```
packages/core/      domain, storage, templating, channel adapters
packages/api/       NestJS control plane + the console
packages/workers/   per-channel delivery handlers
packages/e2e/       full-stack test suite
infra/              AWS CDK
```

More: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
this guide as a web page: [`docs/guide.html`](docs/guide.html)

### Testing

```bash
pnpm verify     # typecheck + tests + end-to-end + cdk synth
```

97 tests, nothing mocked. The repository tests run against real DynamoDB; the
end-to-end suite drives real HTTP through the real app, real queues and real
SMTP. A mock would happily accept a database constraint the real engine rejects.

---

## Status

Runs end to end locally with all suites green. **Not yet deployed to AWS** — the
infrastructure compiles and CI enforces that, but the first deploy needs your
credentials. Client SDKs for Node and Flutter aren't built yet; the snippets
above are the current integration path.

## License

MIT
