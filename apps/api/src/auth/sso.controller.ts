/**
 * Single sign-on via Google (roadmap Phase A — the cheapest procurement/security
 * gate). Standard OAuth 2.0 / OIDC authorization-code flow, hand-rolled on fetch
 * so no new dependency is needed.
 *
 * Two properties matter and are enforced here:
 *
 *  - **SSO signs in, it does not register.** A verified Google email is matched
 *    to an EXISTING REEP account; a stranger with a Google account is redirected
 *    to registration, never logged in. Account creation carries a cohort, a USN
 *    and an approval decision that an OAuth handshake must not make.
 *  - **The email must be verified.** Google's `email_verified` is checked — an
 *    unverified address is somebody's claim, not a fact, and would let anyone
 *    who typed a colleague's email into a fresh Google account sign in as them.
 *
 * State is a random token echoed through Google and checked against a
 * short-lived http-only cookie (CSRF). The whole thing is inert until
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set — /sso/google answers with a
 * clear "not configured" rather than a broken redirect, so it is safe to ship
 * before the client exists.
 */

import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';
import { createSessionToken } from './auth.tokens';
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from './session.types';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const STATE_COOKIE = 'sso_state';

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webOrigin: string;
}

function config(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    // Default to the web origin so the browser stays same-origin through the dev
    // proxy and the session cookie lands on the origin the app calls from.
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI?.trim() ||
      `${process.env.WEB_ORIGIN?.trim() || 'http://localhost:4200'}/api/auth/sso/google/callback`,
    webOrigin: process.env.WEB_ORIGIN?.trim() || 'http://localhost:4200',
  };
}

@Controller('auth/sso')
export class SsoController {
  constructor(private readonly auth: AuthService) {}

  @Get('google')
  start(@Res() res: Response): void {
    const cfg = config();
    if (!cfg) {
      res.status(503).json({
        error: 'SSO is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      });
      return;
    }

    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 10 * 60 * 1000,
      path: '/',
    });

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    res.redirect(`${GOOGLE_AUTH}?${params.toString()}`);
  }

  @Get('google/callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ): Promise<void> {
    const cfg = config();
    if (!cfg) {
      res.status(503).json({ error: 'SSO is not configured.' });
      return;
    }

    const expected = req.cookies?.[STATE_COOKIE] as string | undefined;
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (!code || !state || !expected || state !== expected) {
      res.redirect(`${cfg.webOrigin}/login?error=sso-failed`);
      return;
    }

    const email = await this.exchange(code, cfg);
    if (!email) {
      res.redirect(`${cfg.webOrigin}/login?error=sso-unverified`);
      return;
    }

    const session = await this.auth.ssoSignIn(email);
    if (!session) {
      // Verified, but no REEP account — send them to register, do not sign in.
      res.redirect(`${cfg.webOrigin}/register?email=${encodeURIComponent(email)}`);
      return;
    }

    const token = await createSessionToken(session);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
    res.redirect(cfg.webOrigin + '/');
  }

  /// Trade the code for tokens, then read the verified email. Returns null on
  /// any failure or an unverified address — the caller turns that into a
  /// redirect, never a signed-in session.
  private async exchange(code: string, cfg: GoogleConfig): Promise<string | null> {
    try {
      const tokenRes = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: cfg.redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) return null;
      const { access_token } = (await tokenRes.json()) as { access_token?: string };
      if (!access_token) return null;

      const infoRes = await fetch(GOOGLE_USERINFO, {
        headers: { authorization: `Bearer ${access_token}` },
      });
      if (!infoRes.ok) return null;
      const info = (await infoRes.json()) as { email?: string; email_verified?: boolean };
      if (!info.email || info.email_verified === false) return null;
      return info.email;
    } catch {
      return null;
    }
  }
}
