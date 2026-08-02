import { ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

/**
 * Shared application wiring.
 *
 * Extracted so the HTTP server (main.ts), the Lambda handler (lambda.ts) and
 * the test harness all boot an identically configured app — a pipe configured
 * in only one of them is exactly the kind of drift that makes tests pass while
 * production rejects valid input.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties instead of trusting them into the domain.
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.enableShutdownHooks();

  return app;
}
