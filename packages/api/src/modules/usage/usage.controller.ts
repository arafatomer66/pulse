import { Controller, Get } from '@nestjs/common';
import type { Tenant, UsageSnapshot } from '@pulse/core';
import { CurrentTenant } from '../../common/auth.decorators';
import { PulseService } from '../../core/pulse.service';

@Controller({ path: 'usage', version: '1' })
export class UsageController {
  constructor(private readonly pulse: PulseService) {}

  /** Current billing period against the tenant's plan. No scope required —
   *  every key may read its own account's usage. */
  @Get()
  async current(@CurrentTenant() tenant: Tenant): Promise<UsageSnapshot & { plan: string }> {
    const snapshot = await this.pulse.repos.usage.snapshot(tenant.tenantId, tenant.monthlyQuota);
    return { ...snapshot, plan: tenant.plan };
  }
}
