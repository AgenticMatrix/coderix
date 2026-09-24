/**
 * Test-only helpers, published under `@coderix/tui/testing`.
 *
 * Kept out of `src` so they are never reachable from the library's own entry
 * point, and exported as a subpath so tests in other packages can import them
 * by name instead of reaching across package boundaries with a relative path
 * (which puts the file outside the importing project's `rootDir`).
 */
export { emulate, countRows } from './term-emulator.js';
export type { Screen } from './term-emulator.js';
