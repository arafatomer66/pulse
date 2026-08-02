import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { PulseError, type Template, type Tenant } from '@pulse/core';
import { CurrentTenant, RequireScopes } from '../../common/auth.decorators';
import { PulseService } from '../../core/pulse.service';

class PublishTemplateDto {
  @IsString()
  key!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  category?: string;

  /**
   * `{ en: {...}, bn: {...} }` — `en` is required and acts as the fallback for
   * every other locale, per-channel.
   */
  @IsObject()
  locales!: Record<string, unknown>;
}

@Controller({ path: 'templates', version: '1' })
export class TemplatesController {
  constructor(private readonly pulse: PulseService) {}

  @Get()
  @RequireScopes('templates:read')
  list(@CurrentTenant() tenant: Tenant): Promise<Template[]> {
    return this.pulse.repos.templates.listLatest(tenant.tenantId);
  }

  @Get(':key')
  @RequireScopes('templates:read')
  async get(
    @CurrentTenant() tenant: Tenant,
    @Param('key') key: string,
    @Query('version') version?: string,
  ): Promise<Template> {
    if (version) {
      const parsed = Number(version);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new PulseError('VALIDATION_FAILED', 'version must be a positive integer');
      }
      const found = await this.pulse.repos.templates.getVersion(tenant.tenantId, key, parsed);
      if (!found) throw new PulseError('TEMPLATE_NOT_FOUND', `no template '${key}' v${parsed}`);
      return found;
    }
    return this.pulse.repos.templates.getLatestOrThrow(tenant.tenantId, key);
  }

  /**
   * Publish a new version. Templates are append-only: `POST` and `PUT` both
   * create the next version rather than mutating the current one, so a message
   * already accepted for delivery can never have its text change underneath it.
   */
  @Post()
  @RequireScopes('templates:write')
  publish(@CurrentTenant() tenant: Tenant, @Body() dto: PublishTemplateDto): Promise<Template> {
    return this.publishVersion(tenant, dto.key, dto);
  }

  @Put(':key')
  @RequireScopes('templates:write')
  publishForKey(
    @CurrentTenant() tenant: Tenant,
    @Param('key') key: string,
    @Body() dto: PublishTemplateDto,
  ): Promise<Template> {
    return this.publishVersion(tenant, key, dto);
  }

  private publishVersion(
    tenant: Tenant,
    key: string,
    dto: PublishTemplateDto,
  ): Promise<Template> {
    const locales = dto.locales as Template['locales'];
    if (!locales?.en) {
      throw new PulseError(
        'VALIDATION_FAILED',
        'locales.en is required — it is the fallback every other locale falls back to',
      );
    }
    return this.pulse.repos.templates.publish({
      tenantId: tenant.tenantId,
      key,
      name: dto.name,
      category: dto.category ?? 'transactional',
      locales,
    });
  }
}
