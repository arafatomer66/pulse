import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { IsArray, IsOptional, IsString, IsUrl } from 'class-validator';
import { newEndpointId, type Tenant, type WebhookEndpoint } from '@pulse/core';
import { CurrentTenant, RequireScopes } from '../../common/auth.decorators';
import { PulseService } from '../../core/pulse.service';

class CreateWebhookDto {
  // require_tld is on: a webhook target must be publicly resolvable, and
  // rejecting `http://localhost` here prevents a tenant pointing us at our own
  // internal network.
  @IsUrl({ protocols: ['https', 'http'], require_tld: true })
  url!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];
}

/** The signing secret is returned in full exactly once, at creation. */
type WebhookResponse = Omit<WebhookEndpoint, 'secret'> & { secret?: string };

@Controller({ path: 'webhooks', version: '1' })
export class WebhooksController {
  constructor(private readonly pulse: PulseService) {}

  @Get()
  @RequireScopes('webhooks:write')
  async list(@CurrentTenant() tenant: Tenant): Promise<WebhookResponse[]> {
    const endpoints = await this.pulse.repos.webhooks.list(tenant.tenantId);
    return endpoints.map(redact);
  }

  @Post()
  @RequireScopes('webhooks:write')
  async create(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: CreateWebhookDto,
  ): Promise<WebhookResponse> {
    const endpoint: WebhookEndpoint = {
      tenantId: tenant.tenantId,
      endpointId: newEndpointId(),
      url: dto.url,
      secret: `whsec_${randomBytes(24).toString('hex')}`,
      events: dto.events ?? ['*'],
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    await this.pulse.repos.webhooks.put(endpoint);

    // Full secret, this once — it is unrecoverable afterwards.
    return endpoint;
  }

  @Delete(':endpointId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('webhooks:write')
  async remove(
    @CurrentTenant() tenant: Tenant,
    @Param('endpointId') endpointId: string,
  ): Promise<void> {
    await this.pulse.repos.webhooks.remove(tenant.tenantId, endpointId);
  }
}

function redact(endpoint: WebhookEndpoint): WebhookResponse {
  const { secret, ...rest } = endpoint;
  return { ...rest, secret: `whsec_…${secret.slice(-4)}` };
}
