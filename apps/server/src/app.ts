import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.ts';
import { errorHandler } from './middleware/http.ts';
import { authRouter } from './routes/auth.ts';
import { apiRouter } from './routes/api.ts';
import { ensureBots } from './services/bots.ts';
import { notFound } from './lib/util.ts';

export function createApp() {
  ensureBots();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'blob:', 'data:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: config.isProd,
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  if (!config.isProd) app.use(cors({ origin: config.webOrigin, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const rateLimited = { error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down a little.' } };
  // Brute-force guard for credential endpoints: only failed attempts count, so normal sign-ins
  // aren't throttled. Session refresh runs on every page load and uses the general API limit.
  app.use(
    ['/api/auth/login', '/api/auth/register'],
    rateLimit({
      windowMs: 60_000,
      limit: config.authRateLimitPerMin,
      skipSuccessfulRequests: true,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: rateLimited,
    }),
  );
  app.use(
    ['/api/auth/password-reset/request', '/api/auth/password-reset/complete'],
    rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: rateLimited }),
  );
  app.use(
    '/api',
    rateLimit({ windowMs: 60_000, limit: config.apiRateLimitPerMin, standardHeaders: 'draft-8', legacyHeaders: false, message: rateLimited }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth', authRouter);
  app.use('/api', apiRouter);
  app.use('/api', () => {
    throw notFound('Route not found');
  });

  // Production: serve the built web app with SPA fallback.
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist, {
      index: false,
      maxAge: '1h',
      setHeaders(res, filePath) {
        if (path.basename(filePath) === 'FriendStar.apk') {
          res.setHeader('Content-Type', 'application/vnd.android.package-archive');
          res.setHeader('Content-Disposition', 'attachment; filename="FriendStar.apk"');
        }
      },
    }));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
