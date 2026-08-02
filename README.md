# Pulse

Multi-tenant notification delivery as a service — **email, push, SMS, in-app
inbox and outbound webhooks** behind one API, on AWS serverless.

One API key per project. One `POST`. Pulse handles templating, channel fan-out,
retries, suppression, scheduling, quotas and the delivery audit trail.

```bash
curl -X POST $PULSE/v1/notifications \
  -H "Authorization: Bearer pk_live_…" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-1001-shipped' \
  -d '{
    "to":   { "externalId": "user-42" },
    "templateKey": "order-shipped",
    "data": { "order": { "id": "A-1001", "eta": "Sunday" } }
  }'
```

That one call renders the template in the subscriber's locale, checks their
opt-outs and the suppression list, and delivers on every channel the template
defines — returning a `messageId` you can poll for per-channel results.

## Features

- **Five channels** — email (SES), push (FCM, incl. APNs), SMS (BulkSMS BD or
  SNS), in-app inbox, outbound webhooks with HMAC signatures
- **Bilingual templating** — Liquid, sandboxed, `en`/`bn` with per-channel
  fallback
- **Versioned templates** — append-only, so an edit can't change an in-flight
  message
- **Subscriber preferences** — per-channel and per-category opt-out, one-click
  unsubscribe
- **Suppression list** — automatic on SES bounces and complaints, per tenant
- **Idempotency** — `Idempotency-Key` on send, claim-first so concurrent retries
  can't double-send
- **Scheduling** — SQS delay under 15 minutes, an indexed due-queue beyond it;
  cancellable
- **Quotas and rate limits** — per tenant, enforced with atomic conditional
  counters
- **Delivery log** — every message, every attempt, every provider error

## Quick start

Requires Node ≥24, pnpm 11, Docker.

```bash
pnpm install
docker compose up -d      # DynamoDB Local :8102, ElasticMQ :9324, MailHog :8125
cp .env.example .env
pnpm build
pnpm seed                 # demo tenant + API key + bilingual templates
pnpm dev                  # API on :3100 + workers, in parallel
```

Then send something:

```bash
KEY=pk_test_00000000000000000000000000000000000000000000000000000000demo
SUB=sub_demo000000000000000000

curl -s localhost:3100/v1/notifications \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"to\":{\"subscriberId\":\"$SUB\"},\"templateKey\":\"order-shipped\",
       \"data\":{\"order\":{\"id\":\"A-1001\",\"eta\":\"Sunday\"}}}"
```

The email lands in MailHog at <http://localhost:8125>; the in-app row shows up
at `GET /v1/inbox?subscriberId=$SUB`; per-channel results at
`GET /v1/notifications/{messageId}`.

## Verify

```bash
pnpm verify     # typecheck + unit/integration + e2e + cdk synth
```

| Suite | What it proves |
|---|---|
| `pnpm --filter @pulse/core test` | 69 tests — rendering, adapters, and repositories against **real DynamoDB Local** (conditional writes, atomic counters, index queries) |
| `pnpm --filter @pulse/e2e test` | 28 tests — real HTTP through the real Nest app, real queues, real SMTP: fan-out, idempotency replay, tenant isolation, suppression, retry→DLQ, scheduling, quota |
| `pnpm --filter @pulse/infra synth` | The CDK stacks compile and bundle |

Nothing is mocked. Mocks would happily "pass" a `ConditionExpression` that
DynamoDB rejects.

## Layout

```
packages/core/      domain — entities, single-table repos, renderer,
                    channel adapters, send pipeline
packages/api/       NestJS control plane → Lambda + local server
packages/workers/   thin per-channel Lambda handlers + local runner
packages/e2e/       full-stack suite
infra/              AWS CDK v2 — Data / Queues / Compute
docs/               ARCHITECTURE.md, openapi.yaml, COSTS.md, runbooks/
```

## Cost

**~$0.40/mo idle**, ~$17/mo of infrastructure at a million notifications.
Delivery is the real cost — SES is $0.10/1000, and SMS in Bangladesh dominates
everything. Full breakdown in [docs/COSTS.md](docs/COSTS.md).

## Docs

- [Architecture](docs/ARCHITECTURE.md) — the shape and the reasoning behind it
- [API reference](docs/openapi.yaml) — OpenAPI 3.1
- [Costs](docs/COSTS.md)
- [Deploy runbook](docs/runbooks/deploy.md) — incl. SES sandbox exit
- [DLQ triage & replay](docs/runbooks/dlq-replay.md)

## Status

Runs end to end locally with all suites green. **Not yet deployed to AWS** — the
stacks synthesize and CI enforces that, but the first `cdk deploy` needs
credentials and an SES sandbox exit. See the deploy runbook.

## License

MIT
