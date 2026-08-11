/**
 * Stand-in for the `server-only` package, which is not installed and has no
 * runtime behaviour to reproduce.
 *
 * In a Next build, importing `server-only` from a client component is a
 * resolution error — that is the entire mechanism. Under Vitest there is no
 * client graph to protect, so the module only has to exist and export nothing.
 */

export {};
