// Next.js config for @rondel/web.
//
// Kept intentionally minimal — the web package is a client of the
// @rondel/daemon HTTP bridge, not a bundler of daemon runtime code.
//
// Why no `transpilePackages` for @rondel/daemon: we don't import from
// the daemon at all. Domain types for the web package are derived from
// Zod schemas in apps/web/lib/bridge/schemas.ts at the HTTP boundary,
// so there is no daemon source to transpile.

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Typed routes give us compile-time link safety across page additions.
  // Worth it for a dashboard with many routes.
  typedRoutes: true,
  // Silence the "multiple lockfiles detected" warning from parent dirs.
  // This repo's root is our workspace, not whatever lives above it.
  outputFileTracingRoot: dirname(dirname(__dirname)),
};

export default nextConfig;
