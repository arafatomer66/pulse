import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import type { PulseEnvironment } from './config';

interface DataStackProps extends StackProps {
  pulseEnv: PulseEnvironment;
}

/**
 * The single DynamoDB table.
 *
 * Mirrors packages/core/src/table.ts, which is what the local stack and the
 * tests create. The two must stay in step — a GSI added here without adding it
 * there means the tests silently stop covering the query that uses it.
 */
export class DataStack extends Stack {
  readonly table: Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.table = new Table(this, 'PulseTable', {
      tableName: `pulse-${props.pulseEnv.name}`,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      // On-demand: the workload is bursty and idles at zero between sends, so
      // provisioned capacity would be paying for headroom nobody uses.
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      // Reaps expired message logs, inbox items and idempotency claims. Free —
      // TTL deletes are not billed as writes.
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Production data must survive a `cdk destroy` typo.
      removalPolicy: props.pulseEnv.name === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // GSI1 — per-tenant delivery log, newest first.
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // GSI2 — subscriber lookup by the tenant's own user id. Sparse: only
    // subscribers that carry an externalId are replicated into it.
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi2',
      partitionKey: { name: 'gsi2pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // GSI3 — scheduled-message due queue. Sparse, and the attributes are
    // stripped once a message is enqueued, so this index only ever holds
    // pending work regardless of how much history the table accumulates.
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi3',
      partitionKey: { name: 'gsi3pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi3sk', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
  }
}
