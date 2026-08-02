import { keys } from '../keys';
import { PulseError } from '../errors';
import type { Locale, Template, TemplateBodies } from '../types';
import { BaseRepo, type StoredItem } from './base';

interface TemplateItem extends StoredItem {
  entity: 'template';
  tenantId: string;
  key: string;
  version: number;
  name: string;
  category: string;
  locales: Template['locales'];
  createdAt: string;
}

/**
 * Templates are append-only and versioned. Editing publishes a new version
 * rather than mutating the old one, so an in-flight or replayed message always
 * renders with the text that was live when it was sent.
 */
export class TemplateRepo extends BaseRepo {
  /** Newest version of a template key, or undefined if the key is unknown. */
  async getLatest(tenantId: string, key: string): Promise<Template | undefined> {
    const { pk, prefix } = keys.templatePrefix(tenantId, key);
    // Descending on a zero-padded version suffix ⇒ first row is the newest.
    const page = await this.queryPrefix<TemplateItem>(pk, prefix, { limit: 1, descending: true });
    const item = page.items[0];
    return item ? toTemplate(item) : undefined;
  }

  async getLatestOrThrow(tenantId: string, key: string): Promise<Template> {
    const t = await this.getLatest(tenantId, key);
    if (!t) throw new PulseError('TEMPLATE_NOT_FOUND', `no template '${key}'`);
    return t;
  }

  async getVersion(tenantId: string, key: string, version: number): Promise<Template | undefined> {
    const item = (await this.getRaw(keys.template(tenantId, key, version))) as
      | TemplateItem
      | undefined;
    return item ? toTemplate(item) : undefined;
  }

  /** List the newest version of every template key for a tenant. */
  async listLatest(tenantId: string): Promise<Template[]> {
    const rows = await this.queryAll<TemplateItem>(keys.tenant(tenantId).pk, 'TMPL#');
    const newest = new Map<string, TemplateItem>();
    for (const row of rows) {
      const seen = newest.get(row.key);
      if (!seen || row.version > seen.version) newest.set(row.key, row);
    }
    return [...newest.values()].map(toTemplate).sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Publish the next version of a template key. */
  async publish(input: {
    tenantId: string;
    key: string;
    name: string;
    category: string;
    locales: Template['locales'];
  }): Promise<Template> {
    const current = await this.getLatest(input.tenantId, input.key);
    const version = (current?.version ?? 0) + 1;
    const template: Template = {
      tenantId: input.tenantId,
      key: input.key,
      version,
      name: input.name,
      category: input.category,
      locales: input.locales,
      createdAt: new Date().toISOString(),
    };
    const k = keys.template(input.tenantId, input.key, version);
    await this.putRaw({ pk: k.pk, sk: k.sk, entity: 'template', ...template });
    return template;
  }
}

/**
 * Pick the bodies for a locale, falling back to `en`.
 *
 * Fallback is per-locale, not per-channel: a `bn` template that defines only
 * email still falls back to `en` for push, so a partially translated template
 * never silently drops a channel.
 */
export function bodiesForLocale(template: Template, locale: Locale): TemplateBodies {
  const wanted = template.locales[locale];
  const fallback = template.locales.en;
  if (!wanted) return fallback;
  return { ...fallback, ...wanted };
}

function toTemplate(i: TemplateItem): Template {
  return {
    tenantId: i.tenantId,
    key: i.key,
    version: i.version,
    name: i.name,
    category: i.category,
    locales: i.locales,
    createdAt: i.createdAt,
  };
}
