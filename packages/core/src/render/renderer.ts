import { Liquid } from 'liquidjs';
import { PulseError } from '../errors';
import type { Channel, Locale, Template, TemplateBodies } from '../types';
import { bodiesForLocale } from '../repos/template.repo';

/**
 * Template rendering.
 *
 * LiquidJS rather than Handlebars: Liquid has no escape hatch to arbitrary JS,
 * so tenant-authored templates (and later, templates written in the admin
 * console by non-engineers) cannot execute code in our Lambda. Unknown
 * variables render empty instead of throwing, which matches Liquid's semantics
 * and keeps a missing optional field from failing a whole send.
 */

const engine = new Liquid({
  strictFilters: true,
  // Undefined variables become '' — a missing `{{ user.nickname }}` should not
  // fail a password-reset email.
  strictVariables: false,
  // Templates come from the database, never the filesystem.
  root: [],
  // Keyed by the source string. Templates are versioned and immutable, so a
  // published edit produces a new source and therefore a new cache entry —
  // there is nothing to invalidate.
  cache: true,
});

export type RenderData = Record<string, unknown>;

export interface RenderedEmail {
  subject: string;
  html: string;
  text?: string;
}
export interface RenderedPush {
  title: string;
  body: string;
  imageUrl?: string;
  data?: Record<string, string>;
}
export interface RenderedSms {
  text: string;
}
export interface RenderedInapp {
  title: string;
  body: string;
  deeplink?: string;
}
export interface RenderedWebhook {
  event: string;
  payload: unknown;
}

export type RenderedPayload =
  | RenderedEmail
  | RenderedPush
  | RenderedSms
  | RenderedInapp
  | RenderedWebhook;

async function tpl(source: string, data: RenderData): Promise<string> {
  try {
    return await engine.parseAndRender(source, data);
  } catch (e) {
    throw new PulseError(
      'TEMPLATE_RENDER_FAILED',
      e instanceof Error ? e.message : 'template render failed',
    );
  }
}

/**
 * Render one channel of a template.
 *
 * Returns `undefined` when the template does not define this channel — the
 * caller records that channel as `skipped` rather than failing the message, so
 * asking for push on an email-only template degrades instead of erroring.
 */
export async function renderChannel(
  template: Template,
  channel: Channel,
  locale: Locale,
  data: RenderData,
): Promise<RenderedPayload | undefined> {
  const bodies: TemplateBodies = bodiesForLocale(template, locale);

  switch (channel) {
    case 'email': {
      const b = bodies.email;
      if (!b) return undefined;
      const [subject, html, text] = await Promise.all([
        tpl(b.subject, data),
        tpl(b.html, data),
        b.text ? tpl(b.text, data) : Promise.resolve(undefined),
      ]);
      return { subject, html, text: text ?? htmlToText(html) };
    }
    case 'push': {
      const b = bodies.push;
      if (!b) return undefined;
      const [title, body, imageUrl] = await Promise.all([
        tpl(b.title, data),
        tpl(b.body, data),
        b.imageUrl ? tpl(b.imageUrl, data) : Promise.resolve(undefined),
      ]);
      // FCM data payloads must be all-strings; render each value and coerce.
      const rendered: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.data ?? {})) {
        rendered[k] = await tpl(String(v), data);
      }
      return { title, body, imageUrl, data: rendered };
    }
    case 'sms': {
      const b = bodies.sms;
      if (!b) return undefined;
      return { text: await tpl(b.text, data) };
    }
    case 'inapp': {
      const b = bodies.inapp;
      if (!b) return undefined;
      const [title, body, deeplink] = await Promise.all([
        tpl(b.title, data),
        tpl(b.body, data),
        b.deeplink ? tpl(b.deeplink, data) : Promise.resolve(undefined),
      ]);
      return { title, body, deeplink };
    }
    case 'webhook': {
      const b = bodies.webhook;
      if (!b) return undefined;
      const event = await tpl(b.event, data);
      if (!b.payload) return { event, payload: data };
      const raw = await tpl(b.payload, data);
      // A template may emit JSON; if it does not parse, ship it as a string
      // rather than failing the send.
      try {
        return { event, payload: JSON.parse(raw) as unknown };
      } catch {
        return { event, payload: raw };
      }
    }
  }
}

/**
 * Minimal HTML→text fallback for the plain-text MIME part.
 *
 * Deliberately crude: a proper converter is a dependency we do not need, and
 * every template that cares can supply its own `text` body. Sending *some*
 * text part materially helps deliverability versus sending none.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}
