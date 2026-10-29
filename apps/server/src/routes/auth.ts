import { Router, type Response } from 'express';
import { loginSchema, passwordResetCompleteSchema, passwordResetRequestSchema, registerSchema } from '@friendstar/shared';
import { config } from '../config.ts';
import { parse, requireAuth, uid } from '../middleware/http.ts';
import { signAccessToken } from '../lib/util.ts';
import { issueRefreshToken, registerUser, revokeByToken, rotateRefreshToken, verifyLogin } from '../services/auth.ts';
import { requireUser, toMe } from '../services/users.ts';
import { recordLoginEvent } from '../services/admin.ts';
import { completePasswordReset, createPasswordResetRequest } from '../services/passwordResets.ts';

const COOKIE = 'fs_rt';
const cookieOpts = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: config.isProd && process.env.INSECURE_COOKIES !== '1',
  path: '/api/auth',
  maxAge: config.refreshTokenTtlMs,
};

function setSession(res: Response, userId: string, refreshToken: string) {
  res.cookie(COOKIE, refreshToken, cookieOpts);
  res.setHeader('Cache-Control', 'no-store');
  return { user: toMe(requireUser(userId)), accessToken: signAccessToken(userId) };
}

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const input = parse(registerSchema, req.body);
  const user = await registerUser(input);
  recordLoginEvent('register', user.id);
  const rt = issueRefreshToken(user.id, req.get('user-agent') ?? '');
  res.status(201).json(setSession(res, user.id, rt));
});

authRouter.post('/login', async (req, res) => {
  const { login, password } = parse(loginSchema, req.body);
  let user;
  try {
    user = await verifyLogin(login, password);
  } catch (err) {
    recordLoginEvent('login_failed', null);
    throw err;
  }
  recordLoginEvent('login', user.id);
  const rt = issueRefreshToken(user.id, req.get('user-agent') ?? '');
  res.json(setSession(res, user.id, rt));
});

authRouter.post('/password-reset/request', (req, res) => {
  const { identifier } = parse(passwordResetRequestSchema, req.body);
  const result = createPasswordResetRequest(identifier);
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
});

authRouter.post('/password-reset/complete', async (req, res) => {
  const { token, password } = parse(passwordResetCompleteSchema, req.body);
  await completePasswordReset(token, password);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ message: 'Password updated. Please sign in again.' });
});

authRouter.post('/refresh', (req, res) => {
  try {
    const { userId, token } = rotateRefreshToken(req.cookies?.[COOKIE], req.get('user-agent') ?? '');
    res.json(setSession(res, userId, token));
  } catch (err) {
    res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
    throw err;
  }
});

authRouter.post('/logout', (req, res) => {
  revokeByToken(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: toMe(requireUser(uid(req))) });
});
