/**
 * Lambda entrypoints.
 *
 * Each channel gets its own function so one channel's failures, concurrency
 * limits and DLQ stay isolated from the others — a wedged SMS gateway must not
 * be able to stall email delivery.
 */
export {
  createChannelHandler,
  emailHandler,
  pushHandler,
  smsHandler,
  inappHandler,
  webhookHandler,
} from './handler';
export { bounceHandler } from './bounce.handler';
export { scheduleHandler } from './schedule.handler';
export { processJob, MAX_ATTEMPTS } from './process-job';
export type { ProcessOutcome } from './process-job';
