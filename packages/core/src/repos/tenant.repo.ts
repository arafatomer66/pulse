import { keys } from '../keys';
import type { Plan, Tenant } from '../types';
import { BaseRepo, isConditionFailed, type StoredItem } from './base';
import { PulseError } from '../errors';

interface TenantItem extends StoredItem {
  entity: 'tenant';
  tenantId: string;
  name: string;
  plan: Plan;
  status: 'active' | 'suspended';
  monthlyQuota: number;
  rateLimitPerMin: number;
  retentionDays: number;
  createdAt: string;
}

export class TenantRepo extends BaseRepo {
  async get(tenantId: string): Promise<Tenant | undefined> {
    const item = (await this.getRaw(keys.tenant(tenantId))) as TenantItem | undefined;
    return item ? toTenant(item) : undefined;
  }

  async getOrThrow(tenantId: string): Promise<Tenant> {
    const t = await this.get(tenantId);
    if (!t) throw new PulseError('TENANT_NOT_FOUND', `no tenant ${tenantId}`);
    return t;
  }

  async create(tenant: Tenant): Promise<Tenant> {
    const key = keys.tenant(tenant.tenantId);
    try {
      await this.putRaw(
        { pk: key.pk, sk: key.sk, entity: 'tenant', ...tenant },
        'attribute_not_exists(pk)',
      );
    } catch (e) {
      if (isConditionFailed(e)) {
        throw new PulseError('DUPLICATE_RESOURCE', `tenant ${tenant.tenantId} already exists`);
      }
      throw e;
    }
    return tenant;
  }

  /** Full replace — callers read-modify-write, and tenant records are edited
   *  only from the admin path where concurrent edits are not a concern. */
  async put(tenant: Tenant): Promise<Tenant> {
    const key = keys.tenant(tenant.tenantId);
    await this.putRaw({ pk: key.pk, sk: key.sk, entity: 'tenant', ...tenant });
    return tenant;
  }
}

function toTenant(i: TenantItem): Tenant {
  return {
    tenantId: i.tenantId,
    name: i.name,
    plan: i.plan,
    status: i.status,
    monthlyQuota: i.monthlyQuota,
    rateLimitPerMin: i.rateLimitPerMin,
    retentionDays: i.retentionDays,
    createdAt: i.createdAt,
  };
}
