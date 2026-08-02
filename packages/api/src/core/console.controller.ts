import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Header, NotFoundException, VERSION_NEUTRAL } from '@nestjs/common';
import { Public } from '../common/auth.decorators';

/**
 * Serves the operator console at GET /console.
 *
 * Read from disk on each request in development so edits show up on refresh,
 * and cached in production where the file cannot change under a running Lambda.
 *
 * The console is a single self-contained HTML file with no build step and no
 * external requests — it talks only to this API, from the same origin, so there
 * is no CORS surface and no CDN dependency.
 */
@Controller({ path: 'console', version: VERSION_NEUTRAL })
export class ConsoleController {
  private cached?: string;

  @Public()
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  serve(): string {
    if (this.cached && process.env.NODE_ENV === 'production') return this.cached;

    // __dirname differs between `nest start` (src), the built dist, and the
    // Lambda bundle, so try each layout rather than assuming one.
    const candidates = [
      join(__dirname, '..', '..', 'public', 'console.html'),
      join(__dirname, '..', '..', '..', 'public', 'console.html'),
      join(process.cwd(), 'public', 'console.html'),
      join(process.cwd(), 'packages', 'api', 'public', 'console.html'),
    ];

    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      throw new NotFoundException(
        `console.html not found. Looked in:\n${candidates.join('\n')}`,
      );
    }

    this.cached = readFileSync(found, 'utf8');
    return this.cached;
  }
}
