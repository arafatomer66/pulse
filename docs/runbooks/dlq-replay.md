# Runbook — Dead-letter queue triage and replay

**Alarm:** `pulse-<channel>-dlq-<env>` fired.

Every message in a DLQ is a notification somebody expected and never received.
Treat it as customer-visible.

## 1. What is in there

```bash
CH=email; ENV=prod
Q=$(aws sqs get-queue-url --queue-name pulse-$CH-dlq-$ENV --query QueueUrl --output text)

aws sqs get-queue-attributes --queue-url $Q \
  --attribute-names ApproximateNumberOfMessages

# Peek without consuming — visibility returns to 0 after 5s.
aws sqs receive-message --queue-url $Q --max-number-of-messages 10 \
  --visibility-timeout 5 --query 'Messages[].Body' --output text | jq .
```

The body is a `ChannelJob`: `{ messageId, tenantId, channel, payload, target, … }`.

## 2. Why it failed

The delivery log has the real answer — the DLQ only holds the input.

```bash
aws dynamodb query --table-name pulse-$ENV \
  --key-condition-expression 'pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"MSG#<messageId>"}}' \
  --output json | jq '.Items[] | select(.entity.S=="attempt")'
```

Each attempt row carries `status`, `attempt`, and `error`. Or via the API:
`GET /v1/notifications/{messageId}` as that tenant.

## 3. Common causes

| Symptom in `error` | Cause | Action |
|---|---|---|
| `HTTP 5xx` from a webhook URL | Receiver was down | Replay once the receiver is healthy |
| `Throttling` / `TooManyRequests` | Provider rate limit | Lower worker reserved concurrency, then replay |
| `Email address is not verified` | SES still in sandbox | Finish [deploy.md](./deploy.md) step 5 |
| `Daily message quota exceeded` | SES sending cap | Request a limit increase; replay tomorrow |
| `messaging/registration-token-not-registered` | Dead device tokens | No action — the worker already pruned them |
| `is not E.164` | Bad phone data in the tenant's records | Fix at source; do not replay |
| Handler threw / parse error | A bug | Fix, deploy, then replay |

## 4. Replay

Once the cause is fixed, move messages back to the main queue. Native redrive is
the safest route — it is server-side and preserves bodies exactly:

```bash
SRC=$(aws sqs get-queue-url --queue-name pulse-$CH-dlq-$ENV --query QueueUrl --output text)
DST=$(aws sqs get-queue-url --queue-name pulse-$CH-$ENV --query QueueUrl --output text)

SRC_ARN=$(aws sqs get-queue-attributes --queue-url $SRC \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
DST_ARN=$(aws sqs get-queue-attributes --queue-url $DST \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

TASK=$(aws sqs start-message-move-task \
  --source-arn $SRC_ARN --destination-arn $DST_ARN \
  --max-number-of-messages-per-second 10 \
  --query TaskHandle --output text)

aws sqs list-message-move-tasks --source-arn $SRC_ARN
```

Rate-limit the move (`--max-number-of-messages-per-second`). Dumping a large DLQ
back at full speed re-triggers whatever throttling caused the failure.

### Replay is safe

Delivery is idempotent at the message-record level: the worker re-checks the
message before sending and records the result under the same channel key. A
replayed job that already succeeded overwrites its own result rather than
creating a second one.

It is **not** deduplicated at the *provider* level — replaying a job that did
send will send a second email. If you are unsure whether the original went out,
check `results.<channel>.status` first: `delivered` means do not replay.

## 5. Give up on a message

If a message should not be delivered (stale, wrong recipient, tenant asked for
it to be dropped), delete it and record the outcome so the log is not
misleading:

```bash
aws sqs delete-message --queue-url $SRC --receipt-handle '<handle>'
```

Then set the channel result to `failed` with a reason via a one-off script
against `MessageRepo.recordResult`, so `GET /v1/notifications/{id}` tells the
truth.

## 6. Prevention check

After clearing a DLQ, confirm the alarm returns to OK and look at whether the
cause deserves a code change:

- Repeated 5xx from one tenant's webhook → consider auto-disabling endpoints
  after N consecutive failures.
- Repeated provider throttling → lower `workerConcurrency` in
  `infra/lib/config.ts`.
- Anything that reached the DLQ through a handler *throw* rather than a returned
  failure is a bug — the adapter should have classified it.
