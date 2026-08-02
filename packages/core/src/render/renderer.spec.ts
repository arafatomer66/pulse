import { describe, expect, it } from 'vitest';
import { renderChannel, htmlToText } from './renderer';
import { definedChannels } from '../send/dispatcher';
import type { Template } from '../types';

function template(partial: Partial<Template> = {}): Template {
  return {
    tenantId: 'ten_1',
    key: 'order-shipped',
    version: 1,
    name: 'Order shipped',
    category: 'transactional',
    locales: {
      en: {
        email: {
          subject: 'Order {{ order.id }} shipped',
          html: '<p>Hi {{ subscriber.name }}, your order is on its way.</p>',
        },
        push: { title: 'Shipped', body: 'Order {{ order.id }} is on its way' },
        sms: { text: 'Order {{ order.id }} shipped' },
        inapp: { title: 'Shipped', body: 'Order {{ order.id }}', deeplink: '/orders/{{ order.id }}' },
      },
    },
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

const data = { order: { id: 'A-1001' }, subscriber: { name: 'Omer' } };

describe('renderChannel', () => {
  it('renders an email with subject, html and a derived text part', async () => {
    const out = (await renderChannel(template(), 'email', 'en', data)) as {
      subject: string;
      html: string;
      text?: string;
    };
    expect(out.subject).toBe('Order A-1001 shipped');
    expect(out.html).toContain('Hi Omer');
    // No explicit text body was given, so one is derived for the MIME alternative.
    expect(out.text).toBe('Hi Omer, your order is on its way.');
  });

  it('renders push, sms and inapp bodies', async () => {
    const push = (await renderChannel(template(), 'push', 'en', data)) as { body: string };
    const sms = (await renderChannel(template(), 'sms', 'en', data)) as { text: string };
    const inapp = (await renderChannel(template(), 'inapp', 'en', data)) as { deeplink?: string };

    expect(push.body).toBe('Order A-1001 is on its way');
    expect(sms.text).toBe('Order A-1001 shipped');
    expect(inapp.deeplink).toBe('/orders/A-1001');
  });

  it('returns undefined for a channel the template does not define', async () => {
    expect(await renderChannel(template(), 'webhook', 'en', data)).toBeUndefined();
  });

  it('renders a missing optional variable as empty rather than throwing', async () => {
    const t = template({
      locales: {
        en: { sms: { text: 'Hello {{ missing.deeply.nested }}!' } },
      },
    });
    const out = (await renderChannel(t, 'sms', 'en', {})) as { text: string };
    expect(out.text).toBe('Hello !');
  });

  describe('locale handling', () => {
    const bilingual = template({
      locales: {
        en: {
          email: { subject: 'Order shipped', html: '<p>On its way</p>' },
          sms: { text: 'Order shipped' },
        },
        bn: {
          email: { subject: 'অর্ডার পাঠানো হয়েছে', html: '<p>পথে আছে</p>' },
        },
      },
    });

    it('uses the requested locale when present', async () => {
      const out = (await renderChannel(bilingual, 'email', 'bn', data)) as { subject: string };
      expect(out.subject).toBe('অর্ডার পাঠানো হয়েছে');
    });

    it('falls back to en per-channel so a partial translation drops nothing', async () => {
      // `bn` defines email but not sms — sms must still render from `en`.
      const out = (await renderChannel(bilingual, 'sms', 'bn', data)) as { text: string };
      expect(out.text).toBe('Order shipped');
    });
  });

  describe('webhook payloads', () => {
    it('parses a JSON payload template into an object', async () => {
      const t = template({
        locales: {
          en: { webhook: { event: 'order.shipped', payload: '{"id":"{{ order.id }}"}' } },
        },
      });
      const out = (await renderChannel(t, 'webhook', 'en', data)) as {
        event: string;
        payload: unknown;
      };
      expect(out.event).toBe('order.shipped');
      expect(out.payload).toEqual({ id: 'A-1001' });
    });

    it('defaults the payload to the full data bag when none is given', async () => {
      const t = template({ locales: { en: { webhook: { event: 'order.shipped' } } } });
      const out = (await renderChannel(t, 'webhook', 'en', data)) as { payload: unknown };
      expect(out.payload).toEqual(data);
    });
  });
});

describe('definedChannels', () => {
  it('lists only channels with a body, in a stable order', () => {
    expect(definedChannels(template(), 'en')).toEqual(['email', 'push', 'sms', 'inapp']);
  });

  it('unions the locale overlay with the en base', () => {
    const t = template({
      locales: {
        en: { email: { subject: 's', html: 'h' } },
        bn: { sms: { text: 'বার্তা' } },
      },
    });
    expect(definedChannels(t, 'bn')).toEqual(['email', 'sms']);
  });
});

describe('htmlToText', () => {
  it('strips tags and collapses block elements into newlines', () => {
    expect(htmlToText('<h1>Hi</h1><p>Line one</p><p>Line two</p>')).toBe('Hi\nLine one\nLine two');
  });

  it('drops script and style content entirely', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Visible</p><script>evil()</script>')).toBe(
      'Visible',
    );
  });

  it('decodes the common entities', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &lt;3 &quot;quotes&quot;</p>')).toBe(
      'Tom & Jerry <3 "quotes"',
    );
  });
});
