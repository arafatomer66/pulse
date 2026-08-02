import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { IsString } from 'class-validator';
import type { InboxItem, Tenant } from '@pulse/core';
import { CurrentTenant, RequireScopes } from '../../common/auth.decorators';
import { PaginationQuery, paginated } from '../../common/pagination';
import { PulseService } from '../../core/pulse.service';

class InboxQuery extends PaginationQuery {
  /** Whose feed to read. Always explicit — the key authenticates the tenant,
   *  not the end user, so the subscriber must be named. */
  @IsString()
  subscriberId!: string;
}

@Controller({ path: 'inbox', version: '1' })
export class InboxController {
  constructor(private readonly pulse: PulseService) {}

  @Get()
  @RequireScopes('inbox:read')
  async list(@CurrentTenant() tenant: Tenant, @Query() query: InboxQuery) {
    const page = await this.pulse.repos.inbox.list(tenant.tenantId, query.subscriberId, {
      limit: query.limit,
      cursor: query.cursor,
    });
    const unread = await this.pulse.repos.inbox.unreadCount(tenant.tenantId, query.subscriberId);
    return { ...paginated<InboxItem>(page.items, page.cursor), unreadCount: unread };
  }

  @Get('unread-count')
  @RequireScopes('inbox:read')
  async unreadCount(
    @CurrentTenant() tenant: Tenant,
    @Query('subscriberId') subscriberId: string,
  ): Promise<{ unreadCount: number }> {
    return {
      unreadCount: await this.pulse.repos.inbox.unreadCount(tenant.tenantId, subscriberId),
    };
  }

  @Post(':itemId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('inbox:read')
  async markRead(
    @CurrentTenant() tenant: Tenant,
    @Param('itemId') itemId: string,
    @Query('subscriberId') subscriberId: string,
  ): Promise<void> {
    // Already-read is a no-op, not an error: a double tap in the UI must not
    // surface a failure.
    await this.pulse.repos.inbox
      .markRead(tenant.tenantId, subscriberId, itemId)
      .catch(() => undefined);
  }

  @Post('read-all')
  @RequireScopes('inbox:read')
  async markAllRead(
    @CurrentTenant() tenant: Tenant,
    @Query('subscriberId') subscriberId: string,
  ): Promise<{ marked: number }> {
    return { marked: await this.pulse.repos.inbox.markAllRead(tenant.tenantId, subscriberId) };
  }
}
