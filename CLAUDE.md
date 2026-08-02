# Pulse — working notes

Multi-tenant notification service (email, push, SMS, in-app, webhook) on AWS
serverless. Standalone: any project calls it with an API key.

Keep this file accurate. If you change a convention, update it in the same commit.

## Run it

```bash
pnpm install
docker compose up -d          # DynamoDB Local :8102, ElasticMQ :9324, MailHog :8125/:1125
cp .env.example .env
pnpm build                    # core → workers → api (api/e2e import core's dist)
pnpm seed                     # idempotent
pnpm dev                      # API :3100 + workers, parallel

pnpm verify                   # typecheck + tests + e2e + cdk synth
```

Demo credentials from `pnpm seed`:
`pk_test_00000000000000000000000000000000000000000000000000000000demo`,
subscriber `sub_demo000000000000000000`, tenant `ten_demo000000000000000000`.

## Layout

```
packages/core/src/
  types.ts            domain types — Channel, Message, ChannelJob, SendOutcome
  errors.ts           frozen ERROR_CODES catalog + PulseError
  keys.ts             EVERY single-table key. No 'TENANT#…' string elsewhere.
  config.ts           loadConfig(env) → PulseConfig (plain, no DI)
  ids.ts              ULIDs, API-key generation + sha256, TTL helpers
  ddb.ts / table.ts   doc client factory; table definition for local + tests
  context.ts          createContext() — repos + adapters, built once per process
  repos/*.repo.ts     one per entity; tenantId is always the first argument
  render/renderer.ts  LiquidJS, per-channel, en/bn with fallback
  channels/*.adapter  email(SES/smtp/log), push(FCM/log), sms(SNS/bulksmsbd/log),
                      webhook(HMAC), inapp
  send/dispatcher.ts  resolve → filter → render → persist → enqueue
packages/api/src/
  bootstrap.ts        createApp() — shared by main.ts, lambda.ts and the e2e suite
  core/               env.ts (zod), pulse.service.ts, health.controller.ts
  common/             auth.guard, auth.decorators, http-exception.filter,
                      idempotency.interceptor, pagination
  modules/<name>/     controller (+ service only where it earns its place)
packages/workers/src/
  process-job.ts      the ONE code path all five channels share
  handler.ts          SQS handler factory + per-channel exports
  bounce.handler.ts   SES feedback → suppression list
  schedule.handler.ts EventBridge sweeper for far-future sends
  local-runner.ts     polls ElasticMQ, invokes the REAL handlers in-process
infra/lib/            CDK: data-stack, queues-stack, compute-stack
```

## Hard rules

1. **`tenantId` comes only from the authenticated principal** — never from a
   request body, query or path. Every repo method takes it first. This is the
   whole isolation guarantee; there is an e2e test for it.
2. **All key construction lives in `keys.ts`.** Never concatenate `TENANT#…`
   anywhere else.
3. **Per-channel results are a MAP keyed by channel, never a list.** Five
   workers update one message concurrently; a map lets each write only its own
   key atomically. A list loses updates.
4. **Render in the API, never in a worker.** Content is frozen at accept time so
   a template edit can't change an in-flight message, and template errors are a
   synchronous 422.
5. **Templates are append-only.** Publishing an edit creates the next version.
   Version suffixes are zero-padded so v10 sorts after v9.
6. **Adapters return `SendOutcome`, they don't throw** for expected provider
   failures. `retryable` drives retry-vs-DLQ. A throw is treated as retryable.
7. **`suppressed` and `skipped` are settled successes**, not failures. A message
   where every channel was suppressed rolls up to `delivered`.
8. **Retryable failures are reported to SQS even on the final attempt** — that
   is what lands them in the DLQ for replay instead of vanishing.
9. **Errors leave as `{error:{code,message,details?}}`** with codes from
   `core/src/errors.ts`. Clients switch on `code`, never `message`.
10. **API keys and webhook secrets: store the hash, show the plaintext once.**
11. **zod validates the environment; class-validator validates request DTOs.**
    Don't mix them.
12. **`/v1` URI versioning. `/healthz` and `/admin/v1/*` are `VERSION_NEUTRAL`** —
    without that, admin routes become `/v1/admin/v1/…`.
13. **Never commit `.env`** or provider credentials. Production reads them from
    Secrets Manager.

## Testing

- **vitest 4**, `fileParallelism: false` (suites share one table/queue set).
- Nest specs need **`unplugin-swc` + `oxc: false`** — esbuild and Oxc both drop
  the decorator metadata Nest's DI needs at runtime.
- Integration tests run against **real DynamoDB Local**, not mocks. A mock will
  cheerfully accept a `ConditionExpression` that DynamoDB rejects.
- `packages/e2e` drives the **real Lambda handlers** rather than the background
  poller, so assertions are deterministic and still exercise production code.

## Hard-won lessons

- **DynamoDB Local hangs instead of failing.** With a root-owned named volume it
  can't create its SQLite file, then accepts connections and hangs every API
  call forever while retrying. Hence `user: root` in docker-compose. Readiness
  probes must issue a **real ListTables call** with a request timeout — a TCP
  check passes against a completely broken container.
- The dynamodb-local image ships **neither curl nor wget**, so a compose
  `healthcheck` can never pass. Readiness is polled from Node instead.
- **Port 8100 is taken by `odysseus-chromadb`** on this machine; Pulse uses
  8102. Check `docker ps` before picking any new port.
- **`ExpressionAttributeNames must not be empty`** — DynamoDB rejects an
  UpdateItem with an empty names map, and rejects touching the same attribute
  twice. `recordChannels()` guards both.
- **Quota is consumed before dispatch and refunded on failure.** It can't take a
  channel list, because which channels apply is only known after the template
  and preferences resolve — hence the separate `recordChannels()`.
- **SESv2, not v1**, purely for `EmailTags`. Bounce notifications arrive with no
  tenant context; the `pulse_tenant` tag is the only way to attribute them.
  Without it suppression could only be global.
- **esbuild can't resolve `@nestjs/microservices`/`websockets`** — Nest lazily
  requires them. They're in `externalModules` in the CDK bundling config.
- **`tsx` can't run NestJS** — no `emitDecoratorMetadata`, so DI silently
  injects `undefined`. `pnpm dev` uses `nest start --watch` (tsc).
- **RFC 2047 headers**: long non-ASCII subjects split into multiple
  encoded-words, each independently base64-padded. Decode each to **bytes**,
  concat the buffers, then read UTF-8 — joining the strings truncates at the
  first `=`, and joining decoded strings corrupts split characters.
- **pnpm 11 uses `allowBuilds`**, not `onlyBuiltDependencies`.
- ElasticMQ queue topology in `elasticmq.conf` mirrors the CDK queue
  definitions. `maxReceiveCount: 3` must match `MAX_ATTEMPTS` in
  `process-job.ts` — they're the same policy expressed twice.

## Status

| Phase | State |
|---|---|
| 0 scaffold, docker stack | done |
| 1 core domain + repos + renderer + adapters | done, 69 tests green |
| 2 NestJS API | done, all surfaces mapped |
| 3 channel workers + bounce handler | done, verified end to end |
| 4 SMS adapter, scheduling, broadcast | done |
| 5 CDK, CI, docs, e2e | done, 28 e2e green, synth clean |
| 6 Node SDK | not started |
| 7 Flutter SDK | not started |
| 8 Angular admin console | not started |

**Not deployed.** No AWS credentials on this machine. `docs/runbooks/deploy.md`
has the full sequence; SES sandbox exit is the long pole (24–48h).

## Deliberate deviation from the plan

The plan specified a **Lambda REQUEST authorizer**. Auth is instead a global
NestJS guard inside the API Lambda. Same security properties — the API function
is the sole consumer of the HTTP API — with one less Lambda, one less cold start
and one less place for auth rules to drift. Revisit if a second consumer appears.

## Open external dependencies

1. **SES domain** — `infra/lib/config.ts` has `CHANGEME.com`. Needs a real
   verified domain plus SPF/DKIM/DMARC, and a support request to exit the
   sandbox.
2. **FCM service account JSON** — blocks real push. `PUSH_PROVIDER=log` until
   then.
3. **BulkSMS BD API key** (greenweb.com.bd, chosen in
   sharedeal-social/spec/VENDORS.md V-02) — blocks real SMS.

All three sit behind adapters with local fakes, so the whole suite runs offline.

## Natural first customer

`~/Desktop/sharedeal-social/api` has the seams already cut: a `notifications`
table with a partial index `notif_push_queue on (created_at) where pushed_at is
null` that nothing has ever written to, a `devices.fcm_token` column always
null, and `auth.service.ts` ending OTP delivery in
`logger.warn('no SMS provider configured')`. A worker claiming unpushed rows and
sending through Pulse is a thin adapter, not a rewrite.
