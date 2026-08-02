import 'reflect-metadata';
import serverlessExpress from '@codegenie/serverless-express';
import type { Handler } from 'aws-lambda';
import { createApp } from './bootstrap';

/**
 * Lambda entrypoint behind API Gateway.
 *
 * The Nest app is built once and cached in module scope, so only a cold start
 * pays the bootstrap cost; warm invocations reuse the same instance and its
 * pooled AWS SDK connections.
 */
let cached: Handler | undefined;

async function build(): Promise<Handler> {
  const app = await createApp();
  await app.init();
  return serverlessExpress({ app: app.getHttpAdapter().getInstance() });
}

export const handler: Handler = async (event, context, callback) => {
  cached ??= await build();
  return cached(event, context, callback);
};
