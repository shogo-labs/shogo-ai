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

async function loadHandlerFromDir(hookDir: string): Promise<((event: any) => Promise<void>) | null> {
  const handlerPath = join(hookDir, 'handler.ts')
  if (!existsSync(handlerPath)) return null

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
 * Load all hooks: bundled + workspace.
 * Workspace hooks take precedence (loaded second, can override by name).
 */
export async function loadAllHooks(workspaceDir: string): Promise<Hook[]> {
  const bundledDir = resolve(__dirname, 'bundled')
  const workspaceHooksDir = join(workspaceDir, 'hooks')

  const bundled = await loadHooksFromDir(bundledDir)
  const workspace = await loadHooksFromDir(workspaceHooksDir)

  const byName = new Map<string, Hook>()
  for (const hook of bundled) byName.set(hook.name, hook)
  for (const hook of workspace) byName.set(hook.name, hook)

  return Array.from(byName.values())
}
