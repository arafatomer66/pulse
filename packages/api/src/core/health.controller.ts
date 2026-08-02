import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { checkDynamo, type DependencyHealth } from '@pulse/core';
import { Public } from '../common/auth.decorators';
import { PulseService } from './pulse.service';

interface HealthResponse {
  status: 'ok' | 'degraded';
  dynamodb: DependencyHealth;
  uptimeSeconds: number;
}

/**
 * Liveness/readiness probe.
 *
 * Version-neutral and public: the load balancer health check must not need an
 * API key, and the path must not move when the API versions.
 */
@Controller({ path: 'healthz', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly pulse: PulseService) {}

  @Public()
  @Get()
  async health(): Promise<HealthResponse> {
    const dynamodb = await checkDynamo(this.pulse.cfg);
    return {
      status: dynamodb.ok ? 'ok' : 'degraded',
      dynamodb,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
