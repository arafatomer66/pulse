import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PulseError } from '@pulse/core';
import type { Request, Response } from 'express';
import { firstValueFrom, from, type Observable } from 'rxjs';
import { PulseService } from '../core/pulse.service';
import type { PulsePrincipal } from './auth.decorators';

export const IDEMPOTENT_KEY = 'pulse:idempotent';

/**
 * Mark a route as replay-safe.
 * @param required when true the request is rejected without an Idempotency-Key.
 */
export const Idempotent = (required = false) => SetMetadata(IDEMPOTENT_KEY, { required });

/**
 * Claim-first idempotency, ported from sharedeal-social's Postgres interceptor.
 *
 * The claim is written BEFORE the handler runs, so two concurrent retries of
 * the same request cannot both reach the send path. On failure the claim is
 * released so a genuinely failed call can be retried; on success the response
 * is stored and replayed verbatim.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly pulse: PulseService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const config = this.reflector.getAllAndOverride<{ required: boolean }>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!config) return next.handle();

    const request = context.switchToHttp().getRequest<Request & { principal?: PulsePrincipal }>();
    const key = request.headers['idempotency-key'];
    const idempotencyKey = typeof key === 'string' ? key.trim() : '';

    if (!idempotencyKey) {
      if (config.required) {
        throw new PulseError(
          'MISSING_IDEMPOTENCY_KEY',
          'this endpoint requires an Idempotency-Key header',
        );
      }
      return next.handle();
    }

    const tenantId = request.principal?.tenant.tenantId;
    if (!tenantId) return next.handle();

    const repo = this.pulse.repos.idempotency;
    const claim = await repo.claim(tenantId, idempotencyKey, request.body);

    if (claim.outcome === 'replay') {
      const response = context.switchToHttp().getResponse<Response>();
      response.status(claim.statusCode);
      // `true` tells the client this is a replay, not a fresh send.
      response.setHeader('idempotent-replay', 'true');
      return from([claim.response]);
    }

    if (claim.outcome === 'in_flight') {
      throw new PulseError(
        'IDEMPOTENCY_KEY_REUSED',
        'a request with this Idempotency-Key is still in flight; retry shortly',
      );
    }

    try {
      const result = await firstValueFrom(next.handle());
      const status = context.switchToHttp().getResponse<Response>().statusCode;
      await repo.complete(tenantId, idempotencyKey, result, status);
      return from([result]);
    } catch (e) {
      // Release so the client can retry a call that genuinely failed. A claim
      // left behind would make every retry replay a response that never existed.
      await repo.release(tenantId, idempotencyKey).catch(() => undefined);
      throw e;
    }
  }
}
