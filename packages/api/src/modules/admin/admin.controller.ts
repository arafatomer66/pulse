import { Body, Controller, Get, Param, Post, VERSION_NEUTRAL } from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import {
  generateApiKey,
  newKeyId,
  newTenantId,
  PulseError,
  SCOPES,
  type ApiKeyRecord,
  type Plan,
  type Scope,
  type Tenant,
} from '@pulse/core';
import { AdminOnly } from '../../common/auth.decorators';
import { PulseService } from '../../core/pulse.service';

class CreateTenantDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsIn(['free', 'growth', 'scale'])
  plan?: Plan;

  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyQuota?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  rateLimitPerMin?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  retentionDays?: number;
}

class CreateApiKeyDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsIn(['pk_live', 'pk_test'])
  prefix?: 'pk_live' | 'pk_test';

  @IsOptional()
  @IsArray()
  @IsIn(SCOPES, { each: true })
  scopes?: Scope[];
}

/**
 * Platform provisioning, guarded by ADMIN_TOKEN rather than a tenant API key —
 * these endpoints create the tenants that API keys belong to, so they cannot be
 * authenticated by one.
 *
 * Mounted at /admin/v1 to keep it clearly separate from the tenant-facing /v1
 * surface, and so it can be blocked at the edge in production.
 */
// VERSION_NEUTRAL, not the default '1': URI versioning would otherwise prefix
// this to /v1/admin/v1/tenants. The admin surface carries its own version in
// the path so it can evolve independently of the tenant-facing API.
@Controller({ path: 'admin/v1/tenants', version: VERSION_NEUTRAL })
@AdminOnly()
export class AdminController {
  constructor(private readonly pulse: PulseService) {}

  @Post()
  async createTenant(@Body() dto: CreateTenantDto): Promise<Tenant> {
    return this.pulse.repos.tenants.create({
      tenantId: newTenantId(),
      name: dto.name,
      plan: dto.plan ?? 'free',
      status: 'active',
      monthlyQuota: dto.monthlyQuota ?? this.pulse.cfg.defaultMonthlyQuota,
      rateLimitPerMin: dto.rateLimitPerMin ?? this.pulse.cfg.defaultRateLimitPerMin,
      retentionDays: dto.retentionDays ?? this.pulse.cfg.messageRetentionDays,
      createdAt: new Date().toISOString(),
    });
  }

  @Get(':tenantId')
  getTenant(@Param('tenantId') tenantId: string): Promise<Tenant> {
    return this.pulse.repos.tenants.getOrThrow(tenantId);
  }

  @Post(':tenantId/suspend')
  async suspend(@Param('tenantId') tenantId: string): Promise<Tenant> {
    const tenant = await this.pulse.repos.tenants.getOrThrow(tenantId);
    return this.pulse.repos.tenants.put({ ...tenant, status: 'suspended' });
  }

  @Post(':tenantId/activate')
  async activate(@Param('tenantId') tenantId: string): Promise<Tenant> {
    const tenant = await this.pulse.repos.tenants.getOrThrow(tenantId);
    return this.pulse.repos.tenants.put({ ...tenant, status: 'active' });
  }

  /**
   * Issue an API key. The plaintext is in this response and nowhere else — only
   * its sha256 is stored, so it cannot be recovered or re-shown.
   */
  @Post(':tenantId/keys')
  async createKey(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateApiKeyDto,
  ): Promise<Omit<ApiKeyRecord, 'keyHash'> & { key: string; warning: string }> {
    await this.pulse.repos.tenants.getOrThrow(tenantId);

    const generated = generateApiKey(dto.prefix ?? 'pk_live');
    const record: ApiKeyRecord = {
      keyHash: generated.hash,
      keyId: newKeyId(),
      tenantId,
      name: dto.name,
      prefix: generated.prefix,
      last4: generated.last4,
      scopes: dto.scopes ?? [...SCOPES],
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    await this.pulse.repos.apiKeys.create(record);

    const { keyHash: _keyHash, ...safe } = record;
    return {
      ...safe,
      key: generated.plaintext,
      warning: 'Store this key now — it is not recoverable.',
    };
  }

  @Post(':tenantId/keys/:keyHash/revoke')
  async revokeKey(
    @Param('tenantId') tenantId: string,
    @Param('keyHash') keyHash: string,
  ): Promise<{ revoked: true }> {
    const key = await this.pulse.repos.apiKeys.findByHash(keyHash);
    // Scoped so one tenant's admin call cannot revoke another's key by hash.
    if (!key || key.tenantId !== tenantId) {
      throw new PulseError('TENANT_NOT_FOUND', 'no such key for this tenant');
    }
    await this.pulse.repos.apiKeys.revoke(keyHash);
    return { revoked: true };
  }
}
