// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hook Registry
 *
 * Discovers and loads hooks from the workspace hooks/ directory and
 * bundled hooks. Each hook is a directory with a HOOK.md (metadata)
 * and handler.ts (implementation).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import type { Hook, HookMetadata } from './types'

function parseFrontmatter(raw: string): { metadata: Record<string, any>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { metadata: {}, content: raw }

  const [, frontmatter, content] = match
  const metadata: Record<string, any> = {}

  for (const line of frontmatter.split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.substring(0, colonIndex).trim()
    let value = line.substring(colonIndex + 1).trim()

    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1)
      metadata[key] = value.split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter(Boolean)
    } else if (value.startsWith('"') && value.endsWith('"')) {
      metadata[key] = value.slice(1, -1)
    } else {
      metadata[key] = value
    }
  }

  return { metadata, content: content.trim() }
}

function parseHookMetadata(hookDir: string): HookMetadata | null {
  const hookMdPath = join(hookDir, 'HOOK.md')
  if (!existsSync(hookMdPath)) return null

  try {
    const raw = readFileSync(hookMdPath, 'utf-8')
    const { metadata } = parseFrontmatter(raw)

    if (!metadata.name || !metadata.events) return null

    return {
      name: metadata.name,
      description: metadata.description || '',
      events: Array.isArray(metadata.events) ? metadata.events : [metadata.events],
      emoji: metadata.emoji,
    }
  } catch {
    return null
  }
}

// Try compiled extensions first (.mjs/.js/.cjs) so dist consumers don't
// pay a TS-loader penalty, then fall back to .ts so source consumers
// (Bun in dev, tsconfig paths, the `development` export condition) still
// resolve. The first existing file wins.
const HANDLER_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts'] as const

async function loadHandlerFromDir(hookDir: string): Promise<((event: any) => Promise<void>) | null> {
  let handlerPath: string | null = null
  for (const ext of HANDLER_EXTENSIONS) {
    const candidate = join(hookDir, `handler${ext}`)
    if (existsSync(candidate)) {
      handlerPath = candidate
      break
    }
  }
  if (!handlerPath) return null

  try {
    const mod = await import(handlerPath)
    return mod.default || mod.handler || null
  } catch (err: any) {
    console.error(`[Hooks] Failed to load handler from ${hookDir}:`, err.message)
    return null
  }
}

/**
 * Load hooks from a directory. Each subdirectory should contain
 * HOOK.md (metadata) and handler.ts (implementation).
 */
export async function loadHooksFromDir(dir: string): Promise<Hook[]> {
  if (!existsSync(dir)) return []

  const hooks: Hook[] = []
  const entries = readdirSync(dir)

  for (const entry of entries) {
    const hookDir = join(dir, entry)
    if (!statSync(hookDir).isDirectory()) continue

    const metadata = parseHookMetadata(hookDir)
    if (!metadata) continue

    const handler = await loadHandlerFromDir(hookDir)
    if (!handler) continue

    hooks.push({
      name: metadata.name,
      description: metadata.description,
      events: metadata.events,
      handler,
    })
  }

  return hooks
}

/**
 * Load all hooks: bundled (shipped with the SDK) + workspace
 * (`<workspaceDir>/hooks/`). Workspace hooks take precedence — they're
 * loaded second so duplicate-named entries override the bundled
 * defaults.
 *
 * The bundled directory is resolved relative to this file via
 * `import.meta.dir`, so it works whether the SDK is loaded from
 * `packages/sdk/src/hooks/` (development) or
 * `packages/sdk/dist/hooks/` (published). The build pipeline copies
 * `bundled/**` into `dist/hooks/bundled/` so production resolution
 * succeeds.
 */
export async function loadAllHooks(workspaceDir: string): Promise<Hook[]> {
  // `import.meta.dir` is a Bun extension; cast to access it without
  // pulling in `@types/bun`. Falls back to deriving from `import.meta.url`
  // for non-Bun runtimes (e.g. Node consumers of the published dist).
  const meta = import.meta as { dir?: string; url?: string }
  const moduleDir = meta.dir
    ?? (meta.url ? new URL('.', meta.url).pathname : '.')
  const bundledDir = resolve(moduleDir, 'bundled')
  const workspaceHooksDir = join(workspaceDir, 'hooks')

  const bundled = await loadHooksFromDir(bundledDir)
  const workspace = await loadHooksFromDir(workspaceHooksDir)

  const byName = new Map<string, Hook>()
  for (const hook of bundled) byName.set(hook.name, hook)
  for (const hook of workspace) byName.set(hook.name, hook)

  return Array.from(byName.values())
}
