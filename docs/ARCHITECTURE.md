# Pulse — Architecture

## What it is

One service that takes `POST /v1/notifications` and delivers it over email,
push, SMS, an in-app inbox, and outbound webhooks — with templating, retries,
suppression, scheduling, per-tenant quotas, and a delivery audit trail. Any
project can use it with one API key.

## Shape

```
                         ┌──────────────────────────────┐
  Your apps ──API key──► │ API Gateway (HTTP API)        │
                         └──────────────┬───────────────┘
                                        ▼
                            Lambda: Pulse API (NestJS)
                    authenticate → quota → resolve subscriber
                    → render → persist → fan out
                                        │
              ┌────────┬────────┬───────┴───┬──────────┬──────────┐
              ▼        ▼        ▼           ▼          ▼          │ sendAt > 15min
            SQS      SQS      SQS         SQS        SQS          ▼
           email    push      sms       webhook     inapp   EventBridge (1/min)
              │        │        │           │          │          │
              ▼        ▼        ▼           ▼          ▼          ▼
          Worker λ  Worker λ Worker λ   Worker λ   Worker λ   Sweeper λ
              │        │        │           │          │
            SES      FCM    SNS / BD      HTTP     DynamoDB
              │             gateway     (HMAC)      inbox
              ▼
        SNS feedback → Bounce λ → suppression list

     Every queue has a DLQ (maxReceiveCount 3) + CloudWatch alarms.
     All state in ONE DynamoDB table (3 sparse GSIs) with TTL on logs.
```

## The decisions that shaped it

### Serverless, not containers
The workload idles at zero between bursts. Fargate + RDS costs ~$40–70/mo just
to exist; this costs roughly nothing when nobody sends and ~$15/mo at a million
notifications. See [COSTS.md](./COSTS.md).

### NestJS for the API, plain handlers for the workers
The control plane is low-volume and benefits from Nest's DI, validation
pipeline, and guards. The workers are the hot path, where a Nest bootstrap would
add ~1s to every cold start for features they do not use. Shared domain logic
lives in `packages/core` and is imported by both, so there is no duplication —
only two different front doors onto it.

### Render in the API, not in the worker
Costs a little request latency, buys three things:

1. A template error is a synchronous `422`, not a dead-letter queue surprise.
2. Content is frozen at accept time — editing a template cannot change what an
   already-accepted message says.
3. Workers stay thin, so they keep a ~100ms cold start.

### One table, three sparse indexes
| Index | Purpose | Sparse? |
|---|---|---|
| main `pk`/`sk` | everything | — |
| `gsi1` | per-tenant delivery log, newest first | no |
| `gsi2` | subscriber lookup by the tenant's own user id | yes — only subscribers with an `externalId` |
| `gsi3` | scheduled-message due queue | yes — attributes stripped once enqueued, so it only ever holds pending work |

Key construction lives entirely in `packages/core/src/keys.ts`. No `TENANT#…`
string is built anywhere else, so the access patterns are auditable in one file.

### Per-channel results are a map, not a list
Up to five workers update one message concurrently. A map keyed by channel lets
each write only its own key (`SET results.#ch`), which is atomic. A list would
force read-modify-write and silently lose updates. There is a test for exactly
this in `repos.int.spec.ts`.

### Suppression is per-tenant and mandatory
AWS throttles or suspends accounts whose bounce rate exceeds ~5% or complaint
rate ~0.1%. Permanent bounces and all complaints are recorded and skipped on
every later send. It is scoped per tenant so one tenant's bounce cannot block
another's mail to the same address — which is why SES messages carry a
`pulse_tenant` tag (SESv2 `EmailTags`); without it, feedback could not be
attributed.

Transient bounces are deliberately *not* suppressed — a full mailbox resolves on
its own, and suppressing would cut someone off permanently over an afternoon.

### Settled ≠ delivered ≠ failed
`suppressed` (opted out, on the suppression list) and `skipped` (no template
body, no destination) are terminal successes: we did exactly what preferences
asked. Only `failed` counts against the roll-up. A message where every channel
was suppressed reports `delivered`.

### Retries are the queue's job
The worker classifies a failure as retryable or not and reports retryable ones
back to SQS — including on the final attempt, where `maxReceiveCount` redrives
to the DLQ instead of redelivering. That gives both a truthful delivery log and
a replayable artifact. 4xx from a webhook receiver is never retried; it will
fail identically forever.

### Idempotency claims before it acts
The claim row is written *before* the handler runs, so two concurrent retries
cannot both reach the send path. Released on failure so a genuinely failed call
can be retried. The request body is hashed with a stable stringifier, so key
order does not change the digest.

### Tenant isolation lives in the data layer
`tenantId` comes only from the authenticated principal, never from a request
body or path. Every repository method takes it as the first argument. Same
posture as the "ledgers have one writer" rule in sharedeal-social: the
constraint belongs in the data layer, not in each caller's discipline.

## Deviation from the original plan

The plan called for a **Lambda REQUEST authorizer** in front of API Gateway.
Auth is instead a global NestJS guard inside the API Lambda. The security
properties are identical — the API function is the only consumer of the HTTP
API, so there is no path around the guard — and it removes one Lambda, one cold
start, and one place for the auth rules to drift. If a second consumer is ever
added, extracting the guard into a shared authorizer is a contained change.

## Repository layout

```
pulse/
  packages/
    core/      domain: entities, single-table repos, Liquid renderer,
               channel adapters, error catalog, send pipeline
    api/       NestJS control plane → Lambda handler + local server
    workers/   thin per-channel Lambda handlers + local runner
    e2e/       full-stack suite: real HTTP, real DynamoDB, real SMTP
  infra/       AWS CDK v2 — Data / Queues / Compute stacks
  docs/        this, openapi.yaml, COSTS.md, runbooks/
```

## Local stack

`docker compose up -d` gives DynamoDB Local (8102), ElasticMQ (9324, SQS
wire-compatible) and MailHog (8125 UI / 1125 SMTP). Ports are offset from the
other projects on this machine. The local runner invokes the *real* Lambda
handlers against ElasticMQ, so local behaviour matches deployed behaviour
including partial batch failure handling.
