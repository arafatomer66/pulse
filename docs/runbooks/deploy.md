# Runbook — Deploying Pulse to AWS

Nothing here has been run yet: this machine has no AWS credentials
(`aws sts get-caller-identity` fails). The stacks synthesize cleanly and CI
enforces that, but the first `cdk deploy` is a manual step.

Target account for this project's other work: **111596617601**, region
**ap-south-1** (same as Shipline).

## 1. Credentials

```bash
aws configure          # or: aws sso login --profile pulse
aws sts get-caller-identity     # must succeed before anything below
```

## 2. Bootstrap CDK (once per account/region)

```bash
cd infra
pnpm cdk bootstrap aws://111596617601/ap-south-1
```

## 3. Deploy

```bash
# Dev first — it uses `log` providers, so nothing is actually sent.
pnpm cdk deploy --all -c env=dev

# Production, once dev is verified and SES is out of the sandbox.
pnpm cdk deploy --all -c env=prod
```

Outputs to record: `ApiUrl`, `TableName`, `ProviderSecretArn`,
`SesFeedbackTopicArn`.

## 4. Populate the provider secret

```bash
aws secretsmanager put-secret-value \
  --secret-id pulse/prod/providers \
  --secret-string '{
    "ADMIN_TOKEN": "<48+ random chars>",
    "FCM_SERVICE_ACCOUNT_JSON": "<the whole service-account JSON, escaped>",
    "BULKSMSBD_API_KEY": "<key>",
    "BULKSMSBD_SENDER_ID": "<approved sender id>"
  }'
```

`ADMIN_TOKEN` must be ≥32 characters or the API refuses to boot in production —
that check is in `packages/api/src/core/env.ts`.

## 5. SES — the long pole

SES starts every account in a **sandbox**: you can only send to verified
addresses, capped at 200/day. Getting out takes a support request and typically
24–48 hours, so start this before you need it.

1. **Verify the domain** (not just an address — domain verification is what
   allows arbitrary From addresses and gives better deliverability):
   ```bash
   aws ses verify-domain-identity --domain YOURDOMAIN.com
   ```
   Add the returned TXT record, plus DKIM CNAMEs from
   `aws ses verify-domain-dkim`. **Set up SPF and DMARC too** — without them a
   meaningful share of mail lands in spam regardless of SES's reputation.

2. **Create the configuration set** that routes feedback to the bounce handler.
   Its name must match `SES_CONFIGURATION_SET` (`pulse-prod`):
   ```bash
   aws sesv2 create-configuration-set --configuration-set-name pulse-prod

   aws sesv2 create-configuration-set-event-destination \
     --configuration-set-name pulse-prod \
     --event-destination-name feedback \
     --event-destination '{
       "Enabled": true,
       "MatchingEventTypes": ["BOUNCE","COMPLAINT"],
       "SnsDestination": {"TopicArn":"<SesFeedbackTopicArn from step 3>"}
     }'
   ```

   **This is not optional.** Without it the bounce handler never fires, bad
   addresses are never suppressed, and the bounce rate climbs until AWS
   throttles or suspends the account.

3. **Request production access** in the SES console → Account dashboard. State
   the use case, expected volume, and that you handle bounces and complaints
   automatically (you do — point at the suppression list).

4. Set `emailFrom` and `sesDomain` in `infra/lib/config.ts` (currently
   `CHANGEME.com`) and redeploy.

## 6. Create the first tenant

```bash
API=https://<apiId>.execute-api.ap-south-1.amazonaws.com
ADMIN=<ADMIN_TOKEN>

TENANT=$(curl -s -X POST $API/admin/v1/tenants \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"ShareDeal Social","plan":"growth"}' | jq -r .tenantId)

curl -s -X POST $API/admin/v1/tenants/$TENANT/keys \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"production"}' | jq -r .key
```

Store that key immediately — only its SHA-256 is kept, so it cannot be shown
again.

## 7. Smoke test

```bash
curl -s $API/healthz | jq          # expect status: ok

curl -s -X POST $API/v1/notifications \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H "Idempotency-Key: smoke-$(date +%s)" \
  -d '{"to":{"email":"you@yourdomain.com"},
       "channels":["email"],
       "content":{"email":{"subject":"Pulse is live","html":"<p>It works.</p>"}}}'
```

Then `GET /v1/notifications/{messageId}` and confirm
`results.email.status == "delivered"`.

## Rollback

```bash
pnpm cdk deploy --all -c env=prod --rollback   # or redeploy the previous commit
```

The prod DynamoDB table has `RemovalPolicy.RETAIN` and point-in-time recovery
enabled, so a stack teardown does not destroy data. `cdk destroy` will leave the
table behind on purpose — delete it by hand only if you mean it.

## FCM

Create a Firebase project, then **Project settings → Service accounts →
Generate new private key**. The whole JSON goes into the provider secret as
`FCM_SERVICE_ACCOUNT_JSON`. APNs is routed *through* FCM in V1, so no separate
Apple certificate is needed — configure the APNs auth key inside Firebase
instead.
