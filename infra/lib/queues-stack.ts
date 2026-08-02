import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { ComparisonOperator, Alarm, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { PulseEnvironment } from './config';

export const CHANNELS = ['email', 'push', 'sms', 'inapp', 'webhook'] as const;
export type ChannelName = (typeof CHANNELS)[number];

interface QueuesStackProps extends StackProps {
  pulseEnv: PulseEnvironment;
}

/**
 * One queue plus one dead-letter queue per channel.
 *
 * Separate queues rather than one shared queue with a channel attribute: a
 * wedged SMS gateway must not be able to stall email delivery, and each channel
 * needs its own concurrency limit, its own retry budget and its own alarm.
 */
export class QueuesStack extends Stack {
  readonly queues: Record<ChannelName, Queue>;
  readonly deadLetterQueues: Record<ChannelName, Queue>;
  readonly alarmTopic: Topic;
  /** SES publishes bounce and complaint events here. */
  readonly feedbackTopic: Topic;

  constructor(scope: Construct, id: string, props: QueuesStackProps) {
    super(scope, id, props);
    const suffix = props.pulseEnv.name;

    this.alarmTopic = new Topic(this, 'AlarmTopic', {
      topicName: `pulse-alarms-${suffix}`,
      displayName: 'Pulse alarms',
    });
    if (props.pulseEnv.alarmEmail) {
      this.alarmTopic.addSubscription(new EmailSubscription(props.pulseEnv.alarmEmail));
    }

    this.feedbackTopic = new Topic(this, 'SesFeedbackTopic', {
      topicName: `pulse-ses-feedback-${suffix}`,
      displayName: 'SES bounces and complaints',
    });

    const queues = {} as Record<ChannelName, Queue>;
    const dlqs = {} as Record<ChannelName, Queue>;

    for (const channel of CHANNELS) {
      const dlq = new Queue(this, `${cap(channel)}Dlq`, {
        queueName: `pulse-${channel}-dlq-${suffix}`,
        // Two weeks to notice, diagnose and replay before anything is lost.
        retentionPeriod: Duration.days(14),
        encryption: QueueEncryption.SQS_MANAGED,
      });

      const queue = new Queue(this, `${cap(channel)}Queue`, {
        queueName: `pulse-${channel}-${suffix}`,
        // Six times the worker timeout: SQS requires the visibility timeout to
        // exceed the function timeout, or a slow invocation gets redelivered
        // while it is still running and the notification is sent twice.
        visibilityTimeout: Duration.seconds(180),
        retentionPeriod: Duration.days(4),
        encryption: QueueEncryption.SQS_MANAGED,
        deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      });

      // Anything reaching a DLQ is a notification that was never delivered —
      // always worth a human looking, so the threshold is one.
      new Alarm(this, `${cap(channel)}DlqAlarm`, {
        alarmName: `pulse-${channel}-dlq-${suffix}`,
        alarmDescription: `Messages landed in the ${channel} dead-letter queue`,
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(this.alarmTopic));

      // A backlog means the workers are not keeping up — throttled, erroring,
      // or under-provisioned.
      new Alarm(this, `${cap(channel)}BacklogAlarm`, {
        alarmName: `pulse-${channel}-backlog-${suffix}`,
        alarmDescription: `${channel} queue is backing up`,
        metric: queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5) }),
        threshold: Duration.minutes(15).toSeconds(),
        evaluationPeriods: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(this.alarmTopic));

      queues[channel] = queue;
      dlqs[channel] = dlq;
    }

    this.queues = queues;
    this.deadLetterQueues = dlqs;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
