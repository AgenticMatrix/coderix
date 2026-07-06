// Stub for node:sqlite — not available in Electron 33 (Node.js 20).
// undici uses lazy require() with try-catch to detect this module,
// but Rollup hoists the require to top-level. This stub ensures
// the require succeeds, and undici's feature detection returns false.
module.exports = {};
