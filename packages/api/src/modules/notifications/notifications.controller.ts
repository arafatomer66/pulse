import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Tenant } from '@pulse/core';
import { CurrentTenant, RequireScopes } from '../../common/auth.decorators';
import { Idempotent } from '../../common/idempotency.interceptor';
import { PaginationQuery, paginated } from '../../common/pagination';
import { BroadcastDto, SendNotificationDto } from './notifications.dto';
import { NotificationsService } from './notifications.service';

@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * 202, not 201: we have accepted the message for delivery, we have not
   * delivered it. Per-channel outcomes arrive asynchronously and are read back
   * from GET /v1/notifications/:id.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('notifications:send')
  @Idempotent()
  send(@CurrentTenant() tenant: Tenant, @Body() dto: SendNotificationDto) {
    return this.notifications.send(tenant, dto);
  }

  @Get()
  @RequireScopes('notifications:read')
  async list(@CurrentTenant() tenant: Tenant, @Query() query: PaginationQuery) {
    const page = await this.notifications.list(tenant, query.limit, query.cursor);
    return paginated(page.items, page.cursor);
  }

  @Get(':messageId')
  @RequireScopes('notifications:read')
  get(@CurrentTenant() tenant: Tenant, @Param('messageId') messageId: string) {
    return this.notifications.get(tenant, messageId);
  }

  @Post(':messageId/cancel')
  @RequireScopes('notifications:send')
  cancel(@CurrentTenant() tenant: Tenant, @Param('messageId') messageId: string) {
    return this.notifications.cancel(tenant, messageId);
  }
}

@Controller({ path: 'topics', version: '1' })
export class TopicsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post(':topic/broadcast')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('notifications:send')
  @Idempotent(true)
  broadcast(
    @CurrentTenant() tenant: Tenant,
    @Param('topic') topic: string,
    @Body() dto: BroadcastDto,
  ) {
    return this.notifications.broadcast(tenant, topic, dto);
  }
}

@Controller({ path: 'events', version: '1' })
export class EventsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Delivery log — the same data as GET /v1/notifications, named for humans. */
  @Get()
  @RequireScopes('notifications:read')
  async list(@CurrentTenant() tenant: Tenant, @Query() query: PaginationQuery) {
    const page = await this.notifications.list(tenant, query.limit, query.cursor);
    return paginated(page.items, page.cursor);
  }
}
