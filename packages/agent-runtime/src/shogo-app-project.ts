// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Is this folder a Shogo *app* project — one that codegen turns into a running
 * API sidecar (`server.tsx`)?
 *
 * `PreviewManager` used to answer that with "has a `package.json` and a
 * `prisma/schema.prisma`", which is also true of the platform monorepo root and
 * of every agent checkout of it. There, `shogo.config.json` generates routes
 * and types into `apps/api/src/generated` and `packages/domain-stores/src` and
 * never a server, so codegen produced no `server.tsx`, the sidecar went
 * `crashed`, and on-demand recovery re-ran codegen on every `/api` request
 * (SHO-616). The config file is the authority: a folder gets a sidecar when one
 * of its `outputs[]` entries generates `server`.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

interface ShogoConfigShape {
  outputs?: Array<{ generate?: unknown }>
}

/**
 * True when `<cwd>/shogo.config.json` declares a `server` output, i.e. running
 * the generate pipeline here would write `server.tsx`.
 *
 * - **Config present and readable:** only `"server"` in an `outputs[].generate`
 *   list counts (the monorepo root's outputs list routes/types/mst → false).
 * - **Config missing:** `true`. The runtime template's `scripts/generate.ts`
 *   falls back to the SDK's default server config and always writes
 *   `server.tsx` (`templates/runtime-template/scripts/generate.ts`, see
 *   `emitServerEntry`), so a project with no config file — an older template,
 *   a hand-rolled app — is still an app project.
 * - **Config present but unparseable:** `true`, for the same reason. We cannot
 *   prove it is not an app, and silently disabling codegen would break a real
 *   one over a JSON typo; the generate run itself reports the parse failure.
 */
export function emitsServerEntry(cwd: string): boolean {
  const configPath = join(cwd, 'shogo.config.json')
  if (!existsSync(configPath)) return true

  let config: ShogoConfigShape
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8')) as ShogoConfigShape
  } catch {
    return true
  }

  if (!Array.isArray(config.outputs)) return true
  return config.outputs.some(
    (output) => Array.isArray(output?.generate) && output.generate.includes('server'),
  )
}
