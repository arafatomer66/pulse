import 'reflect-metadata';
import { createApp } from './bootstrap';

/** Local / container entrypoint. In AWS the Lambda handler in lambda.ts is used. */
async function bootstrap(): Promise<void> {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3100);

  await app.listen(port, '0.0.0.0');
  console.log(`Pulse API listening on http://localhost:${port} (v1, /healthz)`);
}

void bootstrap();
