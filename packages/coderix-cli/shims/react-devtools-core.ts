/**
 * Build-time stub for `react-devtools-core`.
 *
 * `ink`'s reconciler dynamically imports `./devtools.js` only when
 * `process.env.DEV === 'true'`. That module statically imports the optional
 * `react-devtools-core` peer dependency, which is not installed. Bun's bundler
 * follows the dynamic import statically and fails to resolve the specifier,
 * which breaks `bun build --compile` in scripts/build-dmg.sh.
 *
 * The `paths` alias in the repo-root tsconfig redirects the specifier here so
 * the bundle builds. This module is never reached in production (DEV is unset);
 * `initialize`/`connectToDevTools` mirror the API ink's devtools module calls.
 */
export default {
  initialize(): void {},
  connectToDevTools(): void {},
};
