import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { PulseError, safeEqual, type Scope } from '@pulse/core';
import type { Request } from 'express';
import { PulseService } from '../core/pulse.service';
import {
  IS_ADMIN_KEY,
  IS_PUBLIC_KEY,
  SCOPES_KEY,
  type PulsePrincipal,
} from './auth.decorators';

/**
 * Global API-key guard.
 *
 * One strongly-consistent GetItem on the sha256 of the presented key — no scan,
 * no list. Order matters: authenticate, then check the tenant is active, then
 * scopes, and only then spend a rate-limit token. Charging a token before
 * knowing the caller is legitimate would let an unauthenticated flood exhaust a
 * real tenant's budget.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly pulse: PulseService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { principal?: PulsePrincipal }>();

    if (this.reflector.getAllAndOverride<boolean>(IS_ADMIN_KEY, [handler, controller])) {
      return this.checkAdminToken(request);
    }

    const presented = extractKey(request);
    if (!presented) {
      throw new PulseError(
        'UNAUTHENTICATED',
        'provide an API key via `Authorization: Bearer pk_…` or the `X-API-Key` header',
      );
    }

    const apiKey = await this.pulse.repos.apiKeys.findByPlaintext(presented);
    if (!apiKey) throw new PulseError('INVALID_API_KEY', 'unknown API key');
    if (apiKey.status === 'revoked') throw new PulseError('KEY_REVOKED', 'this API key was revoked');

    const tenant = await this.pulse.repos.tenants.get(apiKey.tenantId);
    if (!tenant) {
      // The key outlived its tenant. Treat as invalid rather than 500-ing.
      throw new PulseError('INVALID_API_KEY', 'API key references a tenant that no longer exists');
    }
    if (tenant.status === 'suspended') {
      throw new PulseError('TENANT_SUSPENDED', 'this account is suspended');
    }

    const required = this.reflector.getAllAndOverride<Scope[]>(SCOPES_KEY, [handler, controller]);
    if (required?.length) {
      const missing = required.filter((s) => !apiKey.scopes.includes(s));
      if (missing.length > 0) {
        throw new PulseError('FORBIDDEN_SCOPE', `API key is missing scope(s): ${missing.join(', ')}`);
      }
    }

    await this.pulse.repos.usage.consumeRateToken(tenant.tenantId, tenant.rateLimitPerMin);

    request.principal = { tenant, apiKey };

    // Telemetry only — a failed stamp must never fail an authenticated request.
    void this.pulse.repos.apiKeys
      .touch(apiKey.keyHash)
      .catch((e: unknown) => this.logger.debug(`lastUsedAt stamp failed: ${String(e)}`));

    return true;
  }

  private checkAdminToken(request: Request): boolean {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected) {
      throw new PulseError('FORBIDDEN_SCOPE', 'admin endpoints are disabled: ADMIN_TOKEN is unset');
    }
    const presented = extractKey(request);
    // Constant-time compare — a length-independent early return would leak the
    // token a character at a time under timing analysis.
    if (!presented || !safeEqual(presented, expected)) {
      throw new PulseError('UNAUTHENTICATED', 'invalid admin token');
    }
    return true;
  }
}

function extractKey(request: Request): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();

  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header.trim();

  return undefined;
}
