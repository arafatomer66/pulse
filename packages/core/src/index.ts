/**
 * @pulse/core — the domain layer shared by the API and the worker Lambdas.
 *
 * Nothing in here depends on NestJS or on the Lambda runtime, so the same code
 * runs in the HTTP API, in a queue consumer, in the local runner and in tests.
 */

export * from './types';
export * from './errors';
export * from './config';
export * from './ids';
export * from './keys';
export { createDocClient, getDocClient, resetDocClient } from './ddb';
export * from './queue';
export * from './context';
export * from './table';
export { checkDynamo } from './health';
export type { DependencyHealth } from './health';

// repositories
export { BaseRepo, encodeCursor, decodeCursor, isConditionFailed } from './repos/base';
export type { Page, PageOptions, StoredItem } from './repos/base';
export { TenantRepo } from './repos/tenant.repo';
export { ApiKeyRepo } from './repos/apikey.repo';
export { TemplateRepo, bodiesForLocale } from './repos/template.repo';
export { SubscriberRepo, isOptedIn } from './repos/subscriber.repo';
export { MessageRepo, rollUpStatus } from './repos/message.repo';
export { InboxRepo } from './repos/inbox.repo';
export { SuppressionRepo } from './repos/suppression.repo';
export { IdempotencyRepo, hashRequest } from './repos/idempotency.repo';
export type { ClaimResult } from './repos/idempotency.repo';
export { UsageRepo } from './repos/usage.repo';
export type { UsageSnapshot } from './repos/usage.repo';
export { WebhookRepo } from './repos/webhook.repo';

// rendering
export { renderChannel, htmlToText } from './render/renderer';
export type {
  RenderData,
  RenderedEmail,
  RenderedPush,
  RenderedSms,
  RenderedInapp,
  RenderedWebhook,
  RenderedPayload,
} from './render/renderer';

// channels
export type { ChannelAdapter } from './channels/adapter';
export { isRetryableProviderError, errorMessage } from './channels/adapter';
export { EmailAdapter } from './channels/email.adapter';
export { PushAdapter } from './channels/push.adapter';
export { SmsAdapter, isE164, normaliseBdPhone } from './channels/sms.adapter';
export {
  WebhookAdapter,
  buildSignature,
  verifySignature,
  SIGNATURE_HEADER,
} from './channels/webhook.adapter';
export { InappAdapter } from './channels/inapp.adapter';

// send pipeline
export { Dispatcher, definedChannels } from './send/dispatcher';
export type { SendRequest, SendRecipient, SendResult } from './send/dispatcher';

// local/test helpers
export { waitForDynamo, waitForSqs, waitForMailhog } from './testing/wait';
