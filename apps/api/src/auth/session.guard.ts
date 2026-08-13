/**
 * The API-side session guard — the NestJS port of `requireSession()`.
 *
 * It reads the http-only cookie, verifies the JWT, and attaches the payload to
 * the request. A route decorated with it can trust `req.session` exists; without
 * a valid cookie it answers 401 before the handler runs. Role narrowing on top
 * of this (requireStudent / requireMentor) is the `@Roles()` metadata below.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '@prisma/client';

import { verifySessionToken } from './auth.tokens';
import { SESSION_COOKIE, type SessionPayload } from './session.types';

export const ROLES_KEY = 'roles';
/// Narrow a route to a set of roles. Empty/absent means any signed-in user.
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

interface RequestWithSession extends Request {
  session?: SessionPayload;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithSession>();
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const session = token ? await verifySessionToken(token) : null;
    if (!session) throw new UnauthorizedException('Sign in to continue.');

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && roles.length > 0 && !roles.includes(session.role)) {
      throw new ForbiddenException('Your role cannot see this.');
    }

    req.session = session;
    return true;
  }
}

/// `@Session()` — the verified payload the guard attached. The param equivalent
/// of reading `getSession()` at the top of a Server Component.
export const Session = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionPayload => {
    const req = context.switchToHttp().getRequest<RequestWithSession>();
    if (!req.session) throw new UnauthorizedException('Sign in to continue.');
    return req.session;
  },
);
