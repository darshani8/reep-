'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Requests that stop when the user stops caring about them.
 *
 * Every mutation on this dashboard used to run to completion no matter what the
 * reader did next, which shows up in three ways:
 *
 *  - **Work nobody is waiting for.** The resume generator runs a 12B model for
 *    about a minute. Navigating away left it running, holding the GPU for a
 *    page that had already gone.
 *  - **State written after unmount.** A `setState` in a `.then()` on a screen
 *    the reader has left is at best wasted and at worst a React warning about a
 *    component that no longer exists.
 *  - **Races.** Two clicks, two requests, and whichever finishes second wins —
 *    which is not necessarily the one the reader asked for last.
 *
 * `run()` fixes all three by superseding: starting a request aborts the one
 * before it, and unmounting aborts whatever is in flight.
 *
 * The result is a tagged union rather than a thrown error because **cancelled
 * is not failed**. A caller that cannot tell them apart shows "something went
 * wrong" to a user who deliberately pressed Cancel, which is worse than showing
 * nothing at all.
 */

export type AbortableResult<T> =
  | { status: 'done'; value: T }
  | { status: 'cancelled' }
  | { status: 'error'; error: Error };

/// `fetch` rejects with a DOMException named AbortError; some polyfills and
/// nested helpers rethrow a plain Error instead, so the name is checked rather
/// than the constructor.
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

export function useAbortable() {
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the screen is a cancellation. Without this the request runs on,
      // and the server keeps doing work for a page that is gone.
      controller.current?.abort();
      controller.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    if (mounted.current) setPending(false);
  }, []);

  const run = useCallback(
    async <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<AbortableResult<T>> => {
      // Supersede rather than queue: the reader's latest intent is the one that
      // matters, and two in-flight writes of the same thing is the bug.
      controller.current?.abort();

      const own = new AbortController();
      controller.current = own;
      if (mounted.current) setPending(true);

      try {
        const value = await task(own.signal);
        // Aborted *during* the await, or the screen went away while we waited:
        // either way nobody wants this result.
        if (own.signal.aborted || !mounted.current) return { status: 'cancelled' };
        return { status: 'done', value };
      } catch (error) {
        if (own.signal.aborted || isAbortError(error)) return { status: 'cancelled' };
        return {
          status: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      } finally {
        // Only clear if this run is still the current one — a superseding run
        // has already installed its own controller and must keep it.
        if (controller.current === own) {
          controller.current = null;
          if (mounted.current) setPending(false);
        }
      }
    },
    [],
  );

  return { run, cancel, pending };
}
