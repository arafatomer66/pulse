# Pulse — Cost model

Region `ap-south-1` (Mumbai). Prices are list as of the 2026 build and will
drift; the ratios are the durable part.

## Infrastructure

Assume one notification fans out to ~2 channels on average, so 1M notifications
is ~2M channel jobs.

| Component | Rate | @ 100k notif/mo | @ 1M notif/mo |
|---|---|---|---|
| API Gateway (HTTP API) | $1.00 / M requests | $0.10 | $1.00 |
| Lambda — API (1024MB ARM, ~120ms) | $0.20/M req + $0.0000133/GB-s | $0.30 | $3.00 |
| Lambda — workers (512MB ARM, ~80ms) | same | $0.15 | $1.50 |
| SQS | $0.40 / M requests | $0.20 | $2.00 |
| DynamoDB on-demand writes | $1.25 / M WCU | $0.60 | $6.00 |
| DynamoDB on-demand reads | $0.25 / M RCU | $0.05 | $0.50 |
| DynamoDB storage (90d retention) | $0.25 / GB-mo | $0.10 | $1.00 |
| CloudWatch Logs | $0.57 / GB ingested | $0.30 | $2.00 |
| Secrets Manager | $0.40 / secret-mo | $0.40 | $0.40 |
| **Infrastructure subtotal** | | **≈ $2.20** | **≈ $17.40** |

**Idle: ~$0.40/mo** — the Secrets Manager entry. Everything else is
per-request. Nothing runs when nobody sends.

That is the whole reason for the serverless shape. The alternatives:

| Shape | Monthly floor | Why rejected |
|---|---|---|
| ECS Fargate + RDS Postgres | ~$40–70 | Pays continuously for a service that idles between bursts |
| Single EC2 t4g.small (Shipline pattern) | ~$10 | Cheap but vertical-only, and one box is a single point of failure for every project depending on it |
| **Lambda + SQS + DynamoDB** | **~$0.40** | Chosen |

## Delivery — this is what actually costs money

| Channel | Rate | @ 1M sends |
|---|---|---|
| Email (SES) | $0.10 / 1,000 | **$100** |
| Push (FCM) | free | $0 |
| In-app | DynamoDB write only | ~$1 |
| Webhook | Lambda time only | ~$1 |
| SMS via BulkSMS BD | ~BDT 0.30–0.50 each | **BDT 300k–500k (~$2,500–4,200)** |
| SMS via AWS SNS to Bangladesh | ~$0.03–0.10 each | **$30,000–100,000** |

Two things follow:

1. **SMS dominates everything.** At scale it is 100–1000× the infrastructure
   cost. This is why `SMS_PROVIDER=bulksmsbd` is the production default and SNS
   is kept only for other geographies — the price difference for Bangladesh is
   roughly two orders of magnitude.
2. **Meter SMS per tenant.** The monthly quota counts messages, not channels,
   which is right for billing simplicity but means an SMS-heavy tenant costs far
   more per quota unit than an email-heavy one. If Pulse is ever billed
   commercially, price SMS separately.

## Cost controls already in place

- **DynamoDB TTL** on the message log, attempts, inbox items and idempotency
  claims. TTL deletes are not billed as writes, so retention costs nothing to
  enforce. Default 90 days, per-tenant.
- **Sparse GSIs.** `gsi2` and `gsi3` only index rows that carry their
  attributes, so the message log is not replicated into indexes that do not need
  it. `gsi3` entries are removed once a scheduled message is enqueued.
- **Log retention capped at 30 days.** CloudWatch ingestion is a real line item
  at volume; unbounded retention quietly becomes one of the larger bills.
- **`externalModules: ['@aws-sdk/*']`** — the SDK is already on the runtime
  image. Bundling it would add megabytes to every cold start.
- **ARM64 (Graviton)** — ~20% cheaper per GB-second than x86, no code changes.
- **Per-tenant quota and rate limit** enforced with a conditional atomic
  counter, so a runaway loop in one tenant's integration cannot generate an
  unbounded bill.
- **Reserved concurrency on workers in prod** (20 per channel) — caps the blast
  radius of a queue flood.

## What to watch after deploy

| Metric | Why |
|---|---|
| SES bounce / complaint rate | Above ~5% / ~0.1% AWS throttles or suspends sending |
| `pulse-*-dlq` depth | Every message there is an undelivered notification (alarmed) |
| Queue oldest-message age | Workers not keeping up (alarmed at 15 min) |
| DynamoDB consumed WCU | The largest infra line item; a spike means a fan-out bug |
| CloudWatch Logs ingested GB | Grows quietly; revisit `LOG_LEVEL` if it climbs |
