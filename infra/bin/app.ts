#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { resolveEnvironment } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { QueuesStack } from '../lib/queues-stack';
import { ComputeStack } from '../lib/compute-stack';

/**
 * Deploy with:  pnpm --filter @pulse/infra deploy -- -c env=prod
 * Synth only:   pnpm --filter @pulse/infra synth
 */
const app = new App();

const pulseEnv = resolveEnvironment(
  (app.node.tryGetContext('env') as string | undefined) ?? process.env.PULSE_ENV,
);

const env = {
  account: pulseEnv.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: pulseEnv.region,
};

const prefix = `Pulse-${pulseEnv.name}`;

const data = new DataStack(app, `${prefix}-Data`, {
  env,
  pulseEnv,
  description: 'Pulse single-table datastore',
});

const queues = new QueuesStack(app, `${prefix}-Queues`, {
  env,
  pulseEnv,
  description: 'Pulse channel queues, dead-letter queues and alarms',
});

const compute = new ComputeStack(app, `${prefix}-Compute`, {
  env,
  pulseEnv,
  table: data.table,
  queues: queues.queues,
  alarmTopic: queues.alarmTopic,
  feedbackTopic: queues.feedbackTopic,
  description: 'Pulse API and delivery workers',
});

// Explicit rather than inferred from the cross-stack references, so the deploy
// order is stable even if a reference is later removed.
compute.addStackDependency(data);
compute.addStackDependency(queues);

Tags.of(app).add('Project', 'pulse');
Tags.of(app).add('Environment', pulseEnv.name);
Tags.of(app).add('ManagedBy', 'cdk');
