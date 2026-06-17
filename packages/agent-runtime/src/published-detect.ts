// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Heuristic that decides whether a published app needs a SERVER-BACKED publish
 * (a running `server.tsx` pod fronting `/api/*`) or can ship as a purely static
 * export to Object Storage.
 *
 * Pulled into its own pure module so the rule is unit-testable without booting
 * the whole runtime. Consumed by the `/agent/server-info` route in server.ts
 * (which reads the files) and by the publish flow via that endpoint.
 *
 * An app is server-backed when EITHER:
 *   - its Prisma schema declares at least one `model` (it has a DB the app
 *     reads/writes at runtime), OR
 *   - `custom-routes.ts` registers any Hono route (`app.get/post/...`).
 *
 * The presence of `server.tsx` alone is NOT a signal: the runtime template
 * always ships one, so a purely-static app (no models, no custom routes) stays
 * on the cheaper static path.
 */

export interface ServerBackedSignals {
  /** Contents of `prisma/schema.prisma`, or null if absent. */
  schemaSource: string | null
  /** Contents of `custom-routes.ts`, or null if absent. */
  customRoutesSource: string | null
  /** Whether `server.tsx` exists (informational only). */
  hasServerFile: boolean
}

export interface ServerBackedResult {
  serverBacked: boolean
  hasModels: boolean
  hasCustomRoutes: boolean
  hasServerFile: boolean
}

/** True when the Prisma schema declares at least one `model Foo { ... }`. */
export function schemaHasModels(schemaSource: string | null): boolean {
  if (!schemaSource) return false
  return /^\s*model\s+\w+\s*\{/m.test(schemaSource)
}

/** True when custom-routes.ts registers any Hono route handler. */
export function hasRegisteredRoutes(customRoutesSource: string | null): boolean {
  if (!customRoutesSource) return false
  return /\bapp\.(get|post|put|patch|delete|all|use)\s*\(/.test(customRoutesSource)
}

/** Combine the signals into the server-backed decision. */
export function evaluateServerBacked(signals: ServerBackedSignals): ServerBackedResult {
  const hasModels = schemaHasModels(signals.schemaSource)
  const hasCustomRoutes = hasRegisteredRoutes(signals.customRoutesSource)
  return {
    serverBacked: hasModels || hasCustomRoutes,
    hasModels,
    hasCustomRoutes,
    hasServerFile: signals.hasServerFile,
  }
}
