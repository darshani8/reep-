'use server';

import { redirect } from 'next/navigation';

import { HOME_FOR_ROLE, authenticate, clearSessionCookie, createSessionToken, setSessionCookie } from '@/lib/auth';

export type LoginState = { error?: string };

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const next = String(formData.get('next') ?? '');

  if (!email || !password) {
    return { error: 'Enter both your email and password.' };
  }

  const session = await authenticate(email, password);
  if (!session) {
    return { error: 'Those credentials do not match an account.' };
  }

  await setSessionCookie(await createSessionToken(session));

  // Only honour `next` when it is a same-origin path, so the redirect cannot be
  // pointed at another site.
  const destination =
    next.startsWith('/') && !next.startsWith('//') ? next : HOME_FOR_ROLE[session.role];
  redirect(destination);
}

export async function logoutAction() {
  await clearSessionCookie();
  redirect('/login');
}
