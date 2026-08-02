import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createContext,
  Dispatcher,
  loadConfig,
  type PulseConfig,
  type PulseContext,
} from '@pulse/core';

/**
 * Nest-facing handle on the core context.
 *
 * The context (SDK clients, repositories, adapters) is built once per process
 * and reused across warm Lambda invocations. Nothing on it is per-request, so
 * there is no tenant state to leak between calls — tenant scoping happens by
 * passing tenantId into every repository call.
 */
@Injectable()
export class PulseService {
  readonly cfg: PulseConfig;
  readonly ctx: PulseContext;
  readonly dispatcher: Dispatcher;

  constructor(private readonly config: ConfigService) {
    // Read through ConfigService so the validated env is the single source of
    // truth, then hand core a plain object.
    this.cfg = loadConfig(this.asEnv());
    this.ctx = createContext(this.cfg);
    this.dispatcher = new Dispatcher(this.ctx);
  }

  get repos(): PulseContext['repos'] {
    return this.ctx.repos;
  }

  private asEnv(): NodeJS.ProcessEnv {
    const keys = [
      'AWS_REGION',
      'DYNAMODB_ENDPOINT',
      'SQS_ENDPOINT',
      'PULSE_TABLE',
      'QUEUE_URL_PREFIX',
      'EMAIL_PROVIDER',
      'EMAIL_FROM',
      'SMTP_HOST',
      'SMTP_PORT',
      'PUSH_PROVIDER',
      'FCM_SERVICE_ACCOUNT_JSON',
      'SMS_PROVIDER',
      'SMS_SENDER_ID',
      'BULKSMSBD_API_KEY',
      'BULKSMSBD_SENDER_ID',
      'DEFAULT_MONTHLY_QUOTA',
      'DEFAULT_RATE_LIMIT_PER_MIN',
      'MESSAGE_RETENTION_DAYS',
      'SCHEDULER_GROUP_NAME',
      'SCHEDULER_TARGET_ARN',
      'SCHEDULER_ROLE_ARN',
    ] as const;

    const env: NodeJS.ProcessEnv = {};
    for (const key of keys) {
      const value = this.config.get<string | number>(key);
      if (value !== undefined && value !== null) env[key] = String(value);
    }
    return env;
  }
}
