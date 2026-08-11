import { redirect } from 'next/navigation';

import { HOME_FOR_ROLE, getSession } from '@/lib/auth';

export default async function RootPage() {
  const session = await getSession();
  redirect(session ? HOME_FOR_ROLE[session.role] : '/login');
}
