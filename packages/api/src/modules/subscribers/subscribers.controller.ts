import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  LOCALES,
  newSubscriberId,
  normaliseBdPhone,
  PulseError,
  type DeviceToken,
  type Locale,
  type Subscriber,
  type SubscriberPreferences,
  type Tenant,
} from '@pulse/core';
import { CurrentTenant, RequireScopes } from '../../common/auth.decorators';
import { PulseService } from '../../core/pulse.service';

class UpsertSubscriberDto {
  /** Supply to update an existing subscriber; omit to create one. */
  @IsOptional()
  @IsString()
  subscriberId?: string;

  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  topics?: string[];
}

class PreferencesDto {
  @IsOptional()
  @IsObject()
  channels?: Record<string, boolean>;

  @IsOptional()
  @IsObject()
  categories?: Record<string, boolean>;
}

class RegisterDeviceDto {
  @IsString()
  token!: string;

  @IsIn(['ios', 'android', 'web'])
  platform!: DeviceToken['platform'];

  @IsOptional()
  @IsString()
  appVersion?: string;
}

class UnsubscribeDto {
  @IsIn(['email', 'push', 'sms', 'inapp', 'webhook'])
  channel!: 'email' | 'push' | 'sms' | 'inapp' | 'webhook';

  @IsOptional()
  @IsBoolean()
  resubscribe?: boolean;
}

/**
 * Subscriber management.
 *
 * Controller-only, matching the house pattern for modules where a service layer
 * would just forward calls: the repository already is the domain layer.
 */
@Controller({ path: 'subscribers', version: '1' })
export class SubscribersController {
  constructor(private readonly pulse: PulseService) {}

  /**
   * Create or update. Upsert rather than separate POST/PUT because callers sync
   * their own user records into Pulse and should not have to track which ones
   * already exist.
   */
  @Post()
  @RequireScopes('subscribers:write')
  async upsert(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: UpsertSubscriberDto,
  ): Promise<Subscriber> {
    const existing = await this.findExisting(tenant.tenantId, dto);
    const now = new Date().toISOString();

    const phone = dto.phone ? normaliseBdPhone(dto.phone) : undefined;
    if (dto.phone && !phone) {
      throw new PulseError(
        'VALIDATION_FAILED',
        `phone '${dto.phone}' is not a recognisable number; use E.164 (+8801…)`,
      );
    }

    const subscriber: Subscriber = {
      tenantId: tenant.tenantId,
      subscriberId: existing?.subscriberId ?? dto.subscriberId ?? newSubscriberId(),
      email: dto.email ?? existing?.email,
      phone: phone ?? existing?.phone,
      locale: dto.locale ?? existing?.locale ?? 'en',
      timezone: dto.timezone ?? existing?.timezone ?? 'Asia/Dhaka',
      externalId: dto.externalId ?? existing?.externalId,
      attributes: { ...existing?.attributes, ...dto.attributes },
      // Preferences are never reset by an upsert — they are the subscriber's,
      // not the caller's, and are edited only through PUT …/preferences.
      preferences: existing?.preferences ?? { channels: {}, categories: {} },
      topics: dto.topics ?? existing?.topics ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    return this.pulse.repos.subscribers.put(subscriber);
  }

  @Get(':subscriberId')
  @RequireScopes('subscribers:read')
  get(@CurrentTenant() tenant: Tenant, @Param('subscriberId') id: string): Promise<Subscriber> {
    return this.pulse.repos.subscribers.getOrThrow(tenant.tenantId, id);
  }

  @Patch(':subscriberId')
  @RequireScopes('subscribers:write')
  async patch(
    @CurrentTenant() tenant: Tenant,
    @Param('subscriberId') id: string,
    @Body() dto: UpsertSubscriberDto,
  ): Promise<Subscriber> {
    return this.upsert(tenant, { ...dto, subscriberId: id });
  }

  @Put(':subscriberId/preferences')
  @RequireScopes('subscribers:write')
  async setPreferences(
    @CurrentTenant() tenant: Tenant,
    @Param('subscriberId') id: string,
    @Body() dto: PreferencesDto,
  ): Promise<SubscriberPreferences> {
    const sub = await this.pulse.repos.subscribers.getOrThrow(tenant.tenantId, id);
    const preferences: SubscriberPreferences = {
      channels: { ...sub.preferences.channels, ...dto.channels },
      categories: { ...sub.preferences.categories, ...dto.categories },
    };
    await this.pulse.repos.subscribers.put({
      ...sub,
      preferences,
      updatedAt: new Date().toISOString(),
    });
    return preferences;
  }

  /** One-click unsubscribe, for List-Unsubscribe headers and footer links. */
  @Post(':subscriberId/unsubscribe')
  @RequireScopes('subscribers:write')
  async unsubscribe(
    @CurrentTenant() tenant: Tenant,
    @Param('subscriberId') id: string,
    @Body() dto: UnsubscribeDto,
  ): Promise<SubscriberPreferences> {
    return this.setPreferences(tenant, id, {
      channels: { [dto.channel]: dto.resubscribe === true },
    });
  }

  // --- device tokens ---

  @Get(':subscriberId/devices')
  @RequireScopes('subscribers:read')
  listDevices(
    @CurrentTenant() tenant: Tenant,
    @Param('subscriberId') id: string,
  ): Promise<DeviceToken[]> {
    return this.pulse.repos.subscribers.listDevices(tenant.tenantId, id);
  }

  @Post(':subscriberId/devices')
  @RequireScopes('subscribers:write')
  async registerDevice(
    @CurrentTenant() tenant: Tenant,
    @Param('subscriberId') id: string,
    @Body() dto: RegisterDeviceDto,
  ): Promise<DeviceToken> {
    // Confirms the subscriber exists before writing a device row that would
    // otherwise dangle.
    await this.pulse.repos.subscribers.getOrThrow(tenant.tenantId, id);
    const now = new Date().toISOString();

    const existing = (await this.pulse.repos.subscribers.listDevices(tenant.tenantId, id)).find(
      (d) => d.token === dto.token,
    );

    return this.pulse.repos.subscribers.addDevice({
      tenantId: tenant.tenantId,
      subscriberId: id,
      token: dto.token,
      platform: dto.platform,
      appVersion: dto.appVersion,
      // Re-registering the same token refreshes lastSeenAt but keeps the
      // original createdAt, so device age stays meaningful.
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
    });
  }

  @Delete(':subscriberId/devices/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('subscribers:write')
  async removeDevice(
    @CurrentTenant() tenant: Tenant,
    @Param('subscriberId') id: string,
    @Param('token') token: string,
  ): Promise<void> {
    await this.pulse.repos.subscribers.removeDevice(tenant.tenantId, id, token);
  }

  private async findExisting(
    tenantId: string,
    dto: UpsertSubscriberDto,
  ): Promise<Subscriber | undefined> {
    if (dto.subscriberId) {
      return this.pulse.repos.subscribers.get(tenantId, dto.subscriberId);
    }
    if (dto.externalId) {
      return this.pulse.repos.subscribers.findByExternalId(tenantId, dto.externalId);
    }
    return undefined;
  }
}
