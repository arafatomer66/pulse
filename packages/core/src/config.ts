/**
 * Runtime configuration for @pulse/core.
 *
 * Deliberately plain `process.env` reading with defaults: core is imported by
 * Lambda handlers that must not pay for a DI container. The API validates the
 * same variables with zod at boot (packages/api/src/core/env.ts) and fails fast;
 * this loader is the lenient runtime view of the same values.
 */

import type { Channel } from './types';

export interface PulseConfig {
  region: string;
  tableName: string;
  /** Set locally to point at DynamoDB Local; empty in AWS so the SDK resolves. */
  dynamodbEndpoint?: string;
  sqsEndpoint?: string;
  queueUrlPrefix: string;
  emailProvider: 'ses' | 'smtp' | 'log';
  emailFrom: string;
  /** SES configuration set that routes bounce/complaint events to SNS. */
  sesConfigurationSet?: string;
  smtpHost: string;
  smtpPort: number;
  pushProvider: 'fcm' | 'log';
  fcmServiceAccountJson?: string;
  smsProvider: 'sns' | 'bulksmsbd' | 'log';
  smsSenderId: string;
  bulkSmsBdApiKey?: string;
  bulkSmsBdSenderId?: string;
  defaultMonthlyQuota: number;
  defaultRateLimitPerMin: number;
  messageRetentionDays: number;
  schedulerGroupName: string;
  schedulerTargetArn?: string;
  schedulerRoleArn?: string;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
}

/** Treat empty-string env vars as unset — compose and CI both hand us `""`. */
function str(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PulseConfig {
  return {
    region: env.AWS_REGION ?? 'ap-south-1',
    tableName: env.PULSE_TABLE ?? 'pulse-main',
    dynamodbEndpoint: str(env.DYNAMODB_ENDPOINT),
    sqsEndpoint: str(env.SQS_ENDPOINT),
    queueUrlPrefix: env.QUEUE_URL_PREFIX ?? 'http://localhost:9324/000000000000',
    emailProvider: (env.EMAIL_PROVIDER as PulseConfig['emailProvider']) ?? 'log',
    emailFrom: env.EMAIL_FROM ?? 'no-reply@pulse.local',
    sesConfigurationSet: str(env.SES_CONFIGURATION_SET),
    smtpHost: env.SMTP_HOST ?? 'localhost',
    smtpPort: num(env.SMTP_PORT, 1125),
    pushProvider: (env.PUSH_PROVIDER as PulseConfig['pushProvider']) ?? 'log',
    fcmServiceAccountJson: str(env.FCM_SERVICE_ACCOUNT_JSON),
    smsProvider: (env.SMS_PROVIDER as PulseConfig['smsProvider']) ?? 'log',
    smsSenderId: env.SMS_SENDER_ID ?? 'PULSE',
    bulkSmsBdApiKey: str(env.BULKSMSBD_API_KEY),
    bulkSmsBdSenderId: str(env.BULKSMSBD_SENDER_ID),
    defaultMonthlyQuota: num(env.DEFAULT_MONTHLY_QUOTA, 100_000),
    defaultRateLimitPerMin: num(env.DEFAULT_RATE_LIMIT_PER_MIN, 600),
    messageRetentionDays: num(env.MESSAGE_RETENTION_DAYS, 90),
    schedulerGroupName: env.SCHEDULER_GROUP_NAME ?? 'pulse-schedules',
    schedulerTargetArn: str(env.SCHEDULER_TARGET_ARN),
    schedulerRoleArn: str(env.SCHEDULER_ROLE_ARN),
  };
}

/** Queue URL for a channel. Same shape locally (ElasticMQ) and in AWS. */
export function queueUrl(cfg: PulseConfig, channel: Channel): string {
  return `${cfg.queueUrlPrefix}/pulse-${channel}`;
}
