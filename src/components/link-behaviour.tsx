'use client';

import NextLink, { type LinkProps as NextLinkProps } from 'next/link';
import { forwardRef } from 'react';

/**
 * Makes every MUI button and link navigate through the Next router.
 *
 * Registered on the theme as `MuiButtonBase.defaultProps.LinkComponent` and
 * `MuiLink.defaultProps.component`, so a page only ever passes `href`.
 *
 * This matters for more than tidiness: passing `component={NextLink}` from a
 * Server Component fails at runtime, because a function cannot be handed to a
 * Client Component as a prop. Setting it once inside the (client) theme keeps
 * every page free of that trap.
 */
export const LinkBehaviour = forwardRef<
  HTMLAnchorElement,
  Omit<NextLinkProps, 'href'> & { href?: NextLinkProps['href']; className?: string }
>(function LinkBehaviour({ href, ...props }, ref) {
  return <NextLink ref={ref} href={href ?? '#'} {...props} />;
});

export default LinkBehaviour;
