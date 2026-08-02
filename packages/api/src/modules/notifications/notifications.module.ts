import { Module } from '@nestjs/common';
import {
  EventsController,
  NotificationsController,
  TopicsController,
} from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController, TopicsController, EventsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
