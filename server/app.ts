import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { sessionMiddleware } from './auth';
import { buildRouter } from './routes';
import { HttpError, type Ctx } from './util';

/** "https://{s}.tiles.example/{z}/{x}/{y}.png" → "https://*.tiles.example" for the Content-Security-Policy. */
function cspSource(urlTemplate: string): string | null {
  const m = urlTemplate.match(/^(https?:\/\/)([^/]+)/);
  return m ? m[1] + m[2].replace('{s}', '*') : null;
}

export function createApp(ctx: Ctx, opts: { staticDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (ctx.config.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Leaflet positions the map with inline styles.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', cspSource(ctx.config.tileUrl)].filter((s): s is string => Boolean(s)),
          connectSrc: ["'self'", cspSource(ctx.config.geocoderUrl)].filter((s): s is string => Boolean(s)),
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));

  // Defence in depth against cross-site request forgery, on top of SameSite cookies:
  // a browser always sends Origin on cross-site writes, and it has to be our own.
  api.use((req, _res, next) => {
    const origin = req.get('origin');
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        /* malformed Origin header */
      }
      if (originHost !== req.host) return next(new HttpError(403, 'Cross-site request blocked.', 'csrf'));
    }
    next();
  });

  if (ctx.config.rateLimit) {
    const limited = (_req: Request, _res: Response, next: NextFunction) =>
      next(new HttpError(429, 'Too many requests. Give it a minute and try again.', 'rate_limited'));
    api.use(rateLimit({ windowMs: 5 * 60_000, limit: 1500, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited }));
    api.use('/auth', rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited }));
  }

  api.use(sessionMiddleware(ctx));
  api.use(buildRouter(ctx));
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found', 'not_found')));
  app.use('/api', api);

  // In production the same server also hands out the built web app.
  const staticDir = opts.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(join(staticDir, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { message: err.message, code: err.code } });
      return;
    }
    const status = (err as { status?: number })?.status;
    if (status === 400 || status === 413) {
      res.status(status).json({ error: { message: 'That request could not be read.', code: 'bad_request' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { message: 'Something went wrong on our side. Please try again.', code: 'server_error' } });
  });

  return app;
}
