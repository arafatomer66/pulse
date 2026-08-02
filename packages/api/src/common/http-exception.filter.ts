import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { isPulseError } from '@pulse/core';
import type { Request, Response } from 'express';

/**
 * Every error leaves as `{ error: { code, message, details? } }`.
 *
 * Clients switch on `code`, never on `message` — messages get reworded, codes
 * do not. Unrecognised errors become a generic INTERNAL_ERROR with the detail
 * logged rather than returned, so a stack trace or a DynamoDB error string
 * never reaches a tenant.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const { status, body } = this.normalise(exception);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(body);
  }

  private normalise(exception: unknown): {
    status: number;
    body: { error: { code: string; message: string; details?: unknown } };
  } {
    if (isPulseError(exception)) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details !== undefined ? { details: exception.details } : {}),
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      // Nest's ValidationPipe returns { message: string[], error, statusCode }.
      // Reshape it into the catalog format so callers see one error envelope.
      if (typeof payload === 'object' && payload !== null && 'message' in payload) {
        const messages = (payload as { message: unknown }).message;
        if (Array.isArray(messages)) {
          return {
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            body: {
              error: {
                code: 'VALIDATION_FAILED',
                message: 'request failed validation',
                details: messages,
              },
            },
          };
        }
      }

      return {
        status,
        body: {
          error: {
            code: codeForStatus(status),
            message: typeof payload === 'string' ? payload : exception.message,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'INTERNAL_ERROR', message: 'internal server error' } },
    };
  }
}

/** Map the framework's bare HTTP errors onto catalog codes. */
function codeForStatus(status: number): string {
  switch (status) {
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN_SCOPE';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_FAILED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  }
}
