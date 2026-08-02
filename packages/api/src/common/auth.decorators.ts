import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ApiKeyRecord, Scope, Tenant } from '@pulse/core';

/**
 * Request-scoped auth context, attached by ApiKeyGuard.
 *
 * `tenantId` is read from HERE and never from a request body or path param —
 * that is the single rule the whole tenant-isolation guarantee rests on.
 */
export interface PulsePrincipal {
  tenant: Tenant;
  apiKey: ApiKeyRecord;
}

export const IS_PUBLIC_KEY = 'pulse:public';
export const SCOPES_KEY = 'pulse:scopes';
export const IS_ADMIN_KEY = 'pulse:admin';

/** Opt a route out of API-key auth entirely (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Require every listed scope on the presented key. */
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(SCOPES_KEY, scopes);

/** Route is guarded by the platform admin token, not by a tenant API key. */
export const AdminOnly = () => SetMetadata(IS_ADMIN_KEY, true);

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): Tenant => {
  const request = ctx.switchToHttp().getRequest<{ principal?: PulsePrincipal }>();
  if (!request.principal) {
    // Only reachable if a controller asks for the tenant on a @Public route.
    throw new Error('CurrentTenant used on a route with no authenticated principal');
  }
  return request.principal.tenant;
});

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PulsePrincipal => {
    const request = ctx.switchToHttp().getRequest<{ principal?: PulsePrincipal }>();
    if (!request.principal) {
      throw new Error('CurrentPrincipal used on a route with no authenticated principal');
    }
    return request.principal;
  },
);
