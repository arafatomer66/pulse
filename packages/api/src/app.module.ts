import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { ApiKeyGuard } from './common/auth.guard';
import { GlobalExceptionFilter } from './common/http-exception.filter';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { CoreModule } from './core/core.module';
import { validateEnv } from './core/env';
import { AdminModule } from './modules/admin/admin.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SubscribersModule } from './modules/subscribers/subscribers.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { UsageModule } from './modules/usage/usage.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // One .env at the repo root serves every package — the API, the workers
      // and the seed script all read the same local stack configuration.
      envFilePath: ['../../.env', '.env'],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        // Health checks would otherwise dominate the log volume.
        autoLogging: { ignore: (req) => req.url === '/healthz' },
        ...(process.env.NODE_ENV !== 'production'
          ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
          : {}),
        redact: {
          // API keys and signing secrets must never reach the log stream.
          paths: [
            'req.headers.authorization',
            'req.headers["x-api-key"]',
            'req.headers["idempotency-key"]',
            'res.headers["set-cookie"]',
          ],
          remove: true,
        },
      },
    }),
    CoreModule,
    NotificationsModule,
    SubscribersModule,
    TemplatesModule,
    InboxModule,
    WebhooksModule,
    UsageModule,
    AdminModule,
  ],
  providers: [
    // Auth first: everything below assumes an authenticated principal.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
