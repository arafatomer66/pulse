import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig, type PulseConfig } from './config';
import { getDocClient } from './ddb';
import { QueuePublisher } from './queue';
import { ApiKeyRepo } from './repos/apikey.repo';
import { IdempotencyRepo } from './repos/idempotency.repo';
import { InboxRepo } from './repos/inbox.repo';
import { MessageRepo } from './repos/message.repo';
import { SubscriberRepo } from './repos/subscriber.repo';
import { SuppressionRepo } from './repos/suppression.repo';
import { TemplateRepo } from './repos/template.repo';
import { TenantRepo } from './repos/tenant.repo';
import { UsageRepo } from './repos/usage.repo';
import { WebhookRepo } from './repos/webhook.repo';
import type { ChannelAdapter } from './channels/adapter';
import { EmailAdapter } from './channels/email.adapter';
import { InappAdapter } from './channels/inapp.adapter';
import { PushAdapter } from './channels/push.adapter';
import { SmsAdapter } from './channels/sms.adapter';
import { WebhookAdapter } from './channels/webhook.adapter';
import type { Channel } from './types';

/**
 * One wired-up set of repositories and adapters.
 *
 * Built once per process and reused across warm Lambda invocations — the API
 * holds it as a Nest provider, the workers as a module-scope singleton. Nothing
 * here is per-request, so there is no tenant state to leak between calls.
 */
export interface PulseContext {
  cfg: PulseConfig;
  doc: DynamoDBDocumentClient;
  queue: QueuePublisher;
  repos: {
    tenants: TenantRepo;
    apiKeys: ApiKeyRepo;
    templates: TemplateRepo;
    subscribers: SubscriberRepo;
    messages: MessageRepo;
    inbox: InboxRepo;
    suppression: SuppressionRepo;
    idempotency: IdempotencyRepo;
    usage: UsageRepo;
    webhooks: WebhookRepo;
  };
  adapters: Record<Channel, ChannelAdapter>;
}

export function createContext(cfg: PulseConfig = loadConfig()): PulseContext {
  const doc = getDocClient(cfg);
  const table = cfg.tableName;

  const inbox = new InboxRepo(doc, table);

  return {
    cfg,
    doc,
    queue: new QueuePublisher(cfg),
    repos: {
      tenants: new TenantRepo(doc, table),
      apiKeys: new ApiKeyRepo(doc, table),
      templates: new TemplateRepo(doc, table),
      subscribers: new SubscriberRepo(doc, table),
      messages: new MessageRepo(doc, table),
      inbox,
      suppression: new SuppressionRepo(doc, table),
      idempotency: new IdempotencyRepo(doc, table),
      usage: new UsageRepo(doc, table),
      webhooks: new WebhookRepo(doc, table),
    },
    adapters: {
      email: new EmailAdapter(cfg),
      push: new PushAdapter(cfg),
      sms: new SmsAdapter(cfg),
      inapp: new InappAdapter(inbox, cfg.messageRetentionDays),
      webhook: new WebhookAdapter(),
    },
  };
}
