/**
 * The auth endpoints the Angular client calls.
 *
 * These are the port of src/app/login/actions.ts and the session read that the
 * Next pages did inline. The cookie is set with the same options the React app
 * used (http-only, lax, twelve hours, path '/'), so the browser handles it the
 * same way and JavaScript never touches the token.
 *
 * The error messages are deliberately vague — "credentials do not match" never
 * reveals whether the email exists — matching the original.
 */

import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';
import { createSessionToken, verifySessionToken } from './auth.tokens';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, type SessionPayload } from './session.types';

interface LoginBody {
  email?: string;
  password?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionPayload | { error: string }> {
    const email = String(body.email ?? '');
    const password = String(body.password ?? '');

    if (!email || !password) {
      res.status(400);
      return { error: 'Enter both your email and password.' };
    }

    const session = await this.auth.authenticate(email, password);
    if (!session) {
      res.status(401);
      return { error: 'Those credentials do not match an account.' };
    }

    const token = await createSessionToken(session);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });

    return session;
  }

  @Get('session')
  async session(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionPayload | { error: string }> {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const payload = token ? await verifySessionToken(token) : null;
    if (!payload) {
      res.status(401);
      return { error: 'Not signed in.' };
    }
    return payload;
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}
