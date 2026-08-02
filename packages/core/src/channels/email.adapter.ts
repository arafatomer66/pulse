import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer, { type Transporter } from 'nodemailer';
import type { PulseConfig } from '../config';
import type { ChannelJob, SendOutcome } from '../types';
import type { RenderedEmail } from '../render/renderer';
import { type ChannelAdapter, errorMessage, isRetryableProviderError } from './adapter';

/**
 * Email delivery.
 *
 * Three providers behind one adapter:
 *   ses  — production (AWS SES v2)
 *   smtp — local dev, pointed at MailHog so e2e can assert on real MIME output
 *   log  — record and drop, for CI with no containers
 *
 * SESv2 rather than v1 specifically for EmailTags: bounce and complaint
 * notifications arrive on a shared SNS topic with no tenant context, and the
 * tags are the only way to attribute them back to a tenant. Without that,
 * suppression could only be global — one tenant's bounce would block another's
 * sends to the same address.
 */
export class EmailAdapter implements ChannelAdapter {
  readonly name = 'email';
  private ses?: SESv2Client;
  private smtp?: Transporter;
  readonly sent: Array<{ to: string; subject: string }> = [];

  constructor(private readonly cfg: PulseConfig) {}

  async send(job: ChannelJob): Promise<SendOutcome> {
    if (job.target.kind !== 'email') {
      return { status: 'failed', error: 'email adapter got a non-email target', retryable: false };
    }
    const to = job.target.address;
    const payload = job.payload as RenderedEmail;

    try {
      switch (this.cfg.emailProvider) {
        case 'ses':
          return await this.sendViaSes(to, payload, job);
        case 'smtp':
          return await this.sendViaSmtp(to, payload);
        case 'log':
          this.sent.push({ to, subject: payload.subject });
          return { status: 'delivered', providerMessageId: `log-${Date.now()}` };
      }
    } catch (e) {
      return {
        status: 'failed',
        error: errorMessage(e),
        retryable: isRetryableProviderError(e),
      };
    }
  }

  private async sendViaSes(
    to: string,
    payload: RenderedEmail,
    job: ChannelJob,
  ): Promise<SendOutcome> {
    this.ses ??= new SESv2Client({ region: this.cfg.region });

    const res = await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: this.cfg.emailFrom,
        Destination: { ToAddresses: [to] },
        // The configuration set is what routes bounce/complaint events to the
        // SNS topic the bounce handler listens on.
        ...(this.cfg.sesConfigurationSet
          ? { ConfigurationSetName: this.cfg.sesConfigurationSet }
          : {}),
        EmailTags: [
          // SES restricts tag values to [A-Za-z0-9_-]; our ids already comply,
          // but sanitise so a future id format cannot silently break feedback.
          { Name: 'pulse_tenant', Value: sanitiseTag(job.tenantId) },
          { Name: 'pulse_message', Value: sanitiseTag(job.messageId) },
        ],
        Content: {
          Simple: {
            Subject: { Data: payload.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: payload.html, Charset: 'UTF-8' },
              // Always include a text part — multipart/alternative scores
              // better with spam filters than HTML alone.
              ...(payload.text ? { Text: { Data: payload.text, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      }),
    );
    return { status: 'delivered', providerMessageId: res.MessageId };
  }

  private async sendViaSmtp(to: string, payload: RenderedEmail): Promise<SendOutcome> {
    this.smtp ??= nodemailer.createTransport({
      host: this.cfg.smtpHost,
      port: this.cfg.smtpPort,
      secure: false,
      // MailHog accepts anything and speaks no TLS.
      ignoreTLS: true,
    });
    const info = await this.smtp.sendMail({
      from: this.cfg.emailFrom,
      to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    });
    return { status: 'delivered', providerMessageId: info.messageId };
  }
}

/** SES tag values allow only letters, digits, underscore and dash. */
function sanitiseTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
}
