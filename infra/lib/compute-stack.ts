import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, type ThrottleSettings } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { LambdaSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Topic } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { CHANNELS, type ChannelName } from './queues-stack';
import type { PulseEnvironment } from './config';

interface ComputeStackProps extends StackProps {
  pulseEnv: PulseEnvironment;
  table: Table;
  queues: Record<ChannelName, Queue>;
  alarmTopic: Topic;
  feedbackTopic: Topic;
}

const REPO_ROOT = path.join(__dirname, '..', '..');
const API_ENTRY = path.join(REPO_ROOT, 'packages/api/src/lambda.ts');
const WORKERS_ENTRY = path.join(REPO_ROOT, 'packages/workers/src/index.ts');

/**
 * Lambdas, the HTTP API, and the event wiring.
 *
 * ARM64 (Graviton) throughout: roughly 20% cheaper per GB-second than x86 with
 * no code changes, and every dependency here is either pure JS or ships an
 * arm64 build.
 */
export class ComputeStack extends Stack {
  readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const { pulseEnv, table, queues } = props;

    // Provider credentials live in Secrets Manager, never in Lambda env vars —
    // env vars are visible to anyone with console read access.
    const providerSecrets = new Secret(this, 'ProviderSecrets', {
      secretName: `pulse/${pulseEnv.name}/providers`,
      description: 'ADMIN_TOKEN, FCM service account JSON, BulkSMS BD API key',
    });

    const commonEnv: Record<string, string> = {
      NODE_ENV: 'production',
      PULSE_TABLE: table.tableName,
      AWS_ACCOUNT_ID: this.account,
      QUEUE_URL_PREFIX: `https://sqs.${this.region}.amazonaws.com/${this.account}`,
      EMAIL_PROVIDER: pulseEnv.emailProvider,
      EMAIL_FROM: pulseEnv.emailFrom,
      PUSH_PROVIDER: pulseEnv.pushProvider,
      SMS_PROVIDER: pulseEnv.smsProvider,
      DEFAULT_MONTHLY_QUOTA: String(pulseEnv.defaultMonthlyQuota),
      DEFAULT_RATE_LIMIT_PER_MIN: String(pulseEnv.defaultRateLimitPerMin),
      MESSAGE_RETENTION_DAYS: String(pulseEnv.messageRetentionDays),
      PROVIDER_SECRET_ARN: providerSecrets.secretArn,
      SES_CONFIGURATION_SET: `pulse-${pulseEnv.name}`,
      // Reuse TCP connections across invocations — without this every SDK call
      // in a warm container pays a fresh TLS handshake.
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
    };

    const bundling: NodejsFunctionProps['bundling'] = {
      minify: true,
      sourceMap: true,
      target: 'node22',
      externalModules: [
        // Already on the Lambda runtime image; bundling it would add megabytes
        // and slow every cold start.
        '@aws-sdk/*',
        // @nestjs/core lazily `require`s these to discover optional features
        // (microservices, websockets). They are not installed and not used, and
        // Nest guards the requires — but esbuild still tries to resolve them at
        // bundle time unless they are declared external.
        '@nestjs/microservices',
        '@nestjs/microservices/microservices-module',
        '@nestjs/websockets',
        '@nestjs/websockets/socket-module',
        'class-transformer/storage',
        // firebase-admin pulls optional gRPC transports the push worker never
        // takes; excluding them keeps the bundle small.
        '@google-cloud/firestore',
        '@google-cloud/storage',
      ],
    };

    const defaults: Partial<NodejsFunctionProps> = {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      bundling,
      environment: commonEnv,
    };

    /**
     * Explicit log group per function.
     *
     * The `logRetention` prop is deprecated because it provisions a custom
     * resource Lambda just to call PutRetentionPolicy. Declaring the group
     * directly is one fewer moving part, and it means the retention is torn
     * down with the stack instead of leaking an unmanaged group.
     */
    const logGroupFor = (name: string): LogGroup =>
      new LogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/pulse-${name.toLowerCase()}-${pulseEnv.name}`,
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    // --- control-plane API -------------------------------------------------

    const apiFn = new NodejsFunction(this, 'ApiFunction', {
      ...defaults,
      functionName: `pulse-api-${pulseEnv.name}`,
      entry: API_ENTRY,
      handler: 'handler',
      // Generous: the send path renders every channel and writes to DynamoDB
      // and SQS before responding.
      timeout: Duration.seconds(29),
      // 1024MB is the knee of the price/performance curve for Nest cold starts
      // — more CPU is allocated proportionally, so a bigger box finishes the
      // bootstrap faster and often costs the same or less overall.
      memorySize: 1024,
      logGroup: logGroupFor('Api'),
      description: 'Pulse control-plane API (NestJS behind API Gateway)',
    });

    table.grantReadWriteData(apiFn);
    providerSecrets.grantRead(apiFn);
    for (const queue of Object.values(queues)) queue.grantSendMessages(apiFn);

    this.api = new HttpApi(this, 'HttpApi', {
      apiName: `pulse-${pulseEnv.name}`,
      description: 'Pulse notification API',
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', apiFn),
    });

    // Account-level backstop only. Per-tenant limits are enforced in the app
    // against a DynamoDB counter, because API Gateway cannot see which tenant a
    // bearer token belongs to.
    const throttle: ThrottleSettings = { rateLimit: 2_000, burstLimit: 4_000 };
    this.api.defaultStage?.node.addDependency(apiFn);
    if (this.api.defaultStage) {
      (this.api.defaultStage.node.defaultChild as { throttle?: ThrottleSettings }).throttle =
        throttle;
    }

    // --- channel workers ---------------------------------------------------

    for (const channel of CHANNELS) {
      const fn = new NodejsFunction(this, `${cap(channel)}Worker`, {
        ...defaults,
        functionName: `pulse-worker-${channel}-${pulseEnv.name}`,
        entry: WORKERS_ENTRY,
        handler: `${channel}Handler`,
        timeout: Duration.seconds(30),
        // Workers do one provider call and two small writes. 512MB is plenty,
        // and keeps the per-message cost down.
        memorySize: 512,
        ...(pulseEnv.workerConcurrency
          ? { reservedConcurrentExecutions: pulseEnv.workerConcurrency }
          : {}),
        logGroup: logGroupFor(`Worker-${channel}`),
        description: `Pulse ${channel} delivery worker`,
      });

      table.grantReadWriteData(fn);
      providerSecrets.grantRead(fn);

      if (channel === 'email' && pulseEnv.emailProvider === 'ses') {
        fn.addToRolePolicy(
          new PolicyStatement({
            actions: ['ses:SendEmail', 'ses:SendRawEmail'],
            resources: ['*'],
          }),
        );
      }
      if (channel === 'sms' && pulseEnv.smsProvider === 'sns') {
        fn.addToRolePolicy(
          new PolicyStatement({ actions: ['sns:Publish'], resources: ['*'] }),
        );
      }

      fn.addEventSource(
        new SqsEventSource(queues[channel], {
          batchSize: 10,
          maxBatchingWindow: Duration.seconds(5),
          // Without this, one failing record fails the whole batch and its nine
          // healthy neighbours get redelivered and re-sent.
          reportBatchItemFailures: true,
        }),
      );

      new Alarm(this, `${cap(channel)}WorkerErrors`, {
        alarmName: `pulse-worker-${channel}-errors-${pulseEnv.name}`,
        alarmDescription: `${channel} worker is throwing`,
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(props.alarmTopic));
    }

    // --- SES feedback ------------------------------------------------------

    const bounceFn = new NodejsFunction(this, 'BounceWorker', {
      ...defaults,
      functionName: `pulse-bounce-${pulseEnv.name}`,
      entry: WORKERS_ENTRY,
      handler: 'bounceHandler',
      timeout: Duration.seconds(30),
      memorySize: 512,
      logGroup: logGroupFor('Bounce'),
      description: 'Writes SES bounces and complaints to the suppression list',
    });
    table.grantReadWriteData(bounceFn);
    props.feedbackTopic.addSubscription(new LambdaSubscription(bounceFn));

    // --- scheduled sends ---------------------------------------------------

    const scheduleFn = new NodejsFunction(this, 'ScheduleSweeper', {
      ...defaults,
      functionName: `pulse-schedule-${pulseEnv.name}`,
      entry: WORKERS_ENTRY,
      handler: 'scheduleHandler',
      timeout: Duration.minutes(2),
      memorySize: 512,
      logGroup: logGroupFor('Schedule'),
      description: 'Enqueues scheduled messages that have come due',
    });
    table.grantReadWriteData(scheduleFn);
    for (const queue of Object.values(queues)) queue.grantSendMessages(scheduleFn);

    // Every minute. SQS covers delays up to 15 minutes on its own, so this only
    // handles sends parked further out — one small indexed query per tick.
    new Rule(this, 'ScheduleSweepRule', {
      ruleName: `pulse-schedule-sweep-${pulseEnv.name}`,
      description: 'Sweeps the scheduled-send due queue',
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [new LambdaTarget(scheduleFn)],
    });

    // --- outputs -----------------------------------------------------------

    new CfnOutput(this, 'ApiUrl', {
      value: this.api.apiEndpoint,
      description: 'Pulse API base URL',
    });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'ProviderSecretArn', { value: providerSecrets.secretArn });
    new CfnOutput(this, 'SesFeedbackTopicArn', {
      value: props.feedbackTopic.topicArn,
      description: 'Point the SES configuration set event destination here',
    });
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
