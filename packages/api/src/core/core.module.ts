import { Global, Module } from '@nestjs/common';
import { ConsoleController } from './console.controller';
import { HealthController } from './health.controller';
import { PulseService } from './pulse.service';

/**
 * @Global so feature modules can inject PulseService without importing this
 * module each time — it is process-wide infrastructure, not a feature.
 */
@Global()
@Module({
  controllers: [HealthController, ConsoleController],
  providers: [PulseService],
  exports: [PulseService],
})
export class CoreModule {}
