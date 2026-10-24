// Entry point for OpenCode's local plugin loader, which resolves a plugin
// directory configured under `plugins` through a root-level index.ts. The
// published package uses the compiled dist/ output via package.json "exports";
// this file re-exports the source so the plugin also loads from a checkout.
export { default, KagiSearchPlugin } from "./src/index.js";
