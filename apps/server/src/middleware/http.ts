import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { HttpError, unauthorized, verifyAccessToken } from '../lib/util.ts';
import { getUserRow } from '../services/users.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw unauthorized();
  const userId = verifyAccessToken(token);
  if (!getUserRow(userId)) throw unauthorized();
  req.userId = userId;
  next();
}

export const uid = (req: Request) => {
  if (!req.userId) throw unauthorized();
  return req.userId;
};

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) fields[issue.path.join('.') || 'form'] ??= issue.message;
    res.status(400).json({ error: { code: 'VALIDATION', message: Object.values(fields)[0] ?? 'Invalid input', fields } });
    return;
  }
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({
      error: { code: tooBig ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION', message: tooBig ? 'That file is too large' : err.message },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, fields: err.fields } });
    return;
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request too large' } });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Malformed JSON' } });
    return;
  }
  console.error('[error]', err instanceof Error ? err.stack : err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
