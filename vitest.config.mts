import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure half of the codebase.
 *
 * Two aliases are all this needs, and both exist because the code under test is
 * written for Next rather than for a bare Node process:
 *
 *  - `@/*` is the tsconfig path mapping. Vite does not read `tsconfig.paths`.
 *  - `server-only` has **no runtime package** — `node_modules/server-only` does
 *    not exist. It typechecks because Next declares it ambiently, and Next
 *    replaces it at bundle time to make importing a server module from a client
 *    component a build error. Outside Next it is an unresolvable specifier, so
 *    anything importing it (18 files under `src/`) is untestable without this
 *    stub. Stubbing it is safe here: the guarantee it provides is a *bundler*
 *    guarantee, and there is no client bundle in a unit test.
 *
 * `environment: 'node'` because nothing here renders. `globals: false` keeps
 * `npm run typecheck` honest — tsconfig already sweeps in every `.ts` file, so
 * the test files and their Prisma-shaped fixtures are typechecked with the rest
 * of the app, and a fixture that drifts from the schema fails the build rather
 * than silently testing a shape that no longer exists.
 */

const src = fileURLToPath(new URL('./src', import.meta.url));
const serverOnlyStub = fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: serverOnlyStub },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    reporters: ['default'],
  },
});
