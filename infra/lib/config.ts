/**
 * Deployment configuration.
 *
 * Everything environment-specific lives here so the stacks read as topology
 * rather than as a pile of conditionals.
 */

export interface PulseEnvironment {
  name: 'dev' | 'prod';
  account?: string;
  region: string;

  /** Verified SES identity messages are sent from. */
  emailFrom: string;
  /** Domain to verify in SES. Leave undefined to skip identity creation. */
  sesDomain?: string;

  emailProvider: 'ses' | 'log';
  pushProvider: 'fcm' | 'log';
  smsProvider: 'sns' | 'bulksmsbd' | 'log';

  defaultMonthlyQuota: number;
  defaultRateLimitPerMin: number;
  messageRetentionDays: number;

  /** Alarms fire to this topic; wire it to email/Slack after deploy. */
  alarmEmail?: string;

  /** Reserved concurrency per channel worker; undefined = unreserved. */
  workerConcurrency?: number;
}

export const environments: Record<string, PulseEnvironment> = {
  dev: {
    name: 'dev',
    // ap-south-1 (Mumbai) — same region as the user's existing Shipline
    // deployment, and the closest region to Bangladesh.
    region: 'ap-south-1',
    emailFrom: 'no-reply@pulse.dev.invalid',
    emailProvider: 'log',
    pushProvider: 'log',
    smsProvider: 'log',
    defaultMonthlyQuota: 10_000,
    defaultRateLimitPerMin: 300,
    messageRetentionDays: 30,
  },
  prod: {
    name: 'prod',
    region: 'ap-south-1',
    emailFrom: 'no-reply@CHANGEME.com',
    sesDomain: 'CHANGEME.com',
    emailProvider: 'ses',
    pushProvider: 'fcm',
    smsProvider: 'bulksmsbd',
    defaultMonthlyQuota: 100_000,
    defaultRateLimitPerMin: 600,
    messageRetentionDays: 90,
    workerConcurrency: 20,
  },
};

export function resolveEnvironment(name: string | undefined): PulseEnvironment {
  const env = environments[name ?? 'dev'];
  if (!env) {
    throw new Error(
      `unknown environment '${name}'. Known: ${Object.keys(environments).join(', ')}`,
    );
  }
  return env;
}
