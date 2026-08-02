import { z } from 'zod';

/**
 * Boot-time environment validation.
 *
 * Same posture as sharedeal-social/api/src/core/env.ts: zod validates the
 * environment once at startup and the process refuses to boot on bad config,
 * rather than surfacing a missing variable as a 500 on the first request that
 * happens to need it. zod is used here and nowhere else — request DTOs use
 * class-validator.
 */

const numeric = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: numeric(3100),
    // 'silent' is a real pino level and is what the test suite uses to keep
    // assertion output readable.
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    AWS_REGION: z.string().default('ap-south-1'),
    DYNAMODB_ENDPOINT: z.string().optional(),
    SQS_ENDPOINT: z.string().optional(),
    PULSE_TABLE: z.string().default('pulse-main'),
    QUEUE_URL_PREFIX: z.string().default('http://localhost:9324/000000000000'),

    EMAIL_PROVIDER: z.enum(['ses', 'smtp', 'log']).default('log'),
    EMAIL_FROM: z.string().default('no-reply@pulse.local'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: numeric(1125),

    PUSH_PROVIDER: z.enum(['fcm', 'log']).default('log'),
    FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),

    SMS_PROVIDER: z.enum(['sns', 'bulksmsbd', 'log']).default('log'),
    SMS_SENDER_ID: z.string().default('PULSE'),
    BULKSMSBD_API_KEY: z.string().optional(),
    BULKSMSBD_SENDER_ID: z.string().optional(),

    DEFAULT_MONTHLY_QUOTA: numeric(100_000),
    DEFAULT_RATE_LIMIT_PER_MIN: numeric(600),
    MESSAGE_RETENTION_DAYS: numeric(90),

    /** Guards the tenant-provisioning endpoints under /admin/v1. */
    ADMIN_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // Production must not silently no-op. `log` providers exist for local dev
    // and CI; shipping them to production would accept sends and deliver
    // nothing, which is worse than failing to boot.
    if (env.EMAIL_PROVIDER === 'log') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_PROVIDER'],
        message: 'EMAIL_PROVIDER=log is a no-op and is not allowed in production',
      });
    }
    if (env.PUSH_PROVIDER === 'fcm' && !env.FCM_SERVICE_ACCOUNT_JSON) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FCM_SERVICE_ACCOUNT_JSON'],
        message: 'PUSH_PROVIDER=fcm requires FCM_SERVICE_ACCOUNT_JSON',
      });
    }
    if (env.SMS_PROVIDER === 'bulksmsbd' && !env.BULKSMSBD_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BULKSMSBD_API_KEY'],
        message: 'SMS_PROVIDER=bulksmsbd requires BULKSMSBD_API_KEY',
      });
    }
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_TOKEN'],
        message: 'ADMIN_TOKEN must be set to at least 32 characters in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  return parsed.data;
}
