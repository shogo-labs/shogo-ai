// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hand a warm pool VM's pre-seeded app to the workspace anchor.
 *
 * An unassigned pool VM cannot know whether it will become a single-project
 * or a workspace runtime, so it pre-seeds the starter app (template files,
 * `node_modules`, Prisma client, `dev.db`, generated `server.tsx` and a
 * pre-built `dist/`) straight into `WORKSPACE_DIR`. A single-project runtime
 * uses that as-is. A workspace runtime serves each project from
 * `<WORKSPACE_DIR>/<projectId>/`, so the root copy is both wasted work (the
 * anchor rebuilt everything from scratch, ~30s) and a trap: the agent's
 * relative paths resolve against the root and edited a copy no preview served.
 *
 * The pool records what it created in a manifest. At assign the entries are
 * renamed into the anchor folder (instant, same filesystem), or deleted from
 * the root when nothing adopts them.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { extname, join } from 'node:path'
import { DEFAULT_WORKSPACE_FILES, getInstallMarkerPath, getRuntimeTemplatePath } from './workspace-defaults'
import { memberHasProjectSource } from './workspace-member-seed'

const MANIFEST_RELATIVE = ['.shogo', 'pool-preseed.json'] as const
const POOL_DIST_RELATIVE = ['.shogo', 'pool-dist'] as const

/** Vite `--base` for the pool's pre-built dist; rewritten to the real base at adoption. */
export const POOL_DIST_BASE_PLACEHOLDER = '/__shogo_pool_base__/'

/**
 * Written into an adopted `dist/`. Holds the sha256 of the template
 * `index.html` so a later hydrate can tell the template bundle apart from a
 * real build and drop it rather than serve the placeholder app.
 */
export const POOL_TEMPLATE_DIST_MARKER = '.shogo-pool-template'

/** Root entries that belong to the workspace itself, never to a project. */
const WORKSPACE_LEVEL_ENTRIES = new Set(['.shogo', 'memory', ...Object.keys(DEFAULT_WORKSPACE_FILES)])

/** Workspace-level names the runtime template also ships a project copy of. */
const TEMPLATE_COPY_SKIP = new Set(['node_modules', '.shogo'])

const DIST_TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.cjs', '.css', '.json', '.map', '.svg', '.txt', '.webmanifest'])

export interface PoolPreseedManifest {
  /** Top-level root entries the pool pre-seed created. */
  entries: string[]
  /** Tech stack the pool seeded (`.tech-stack` at the root). */
  techStackId: string | null
  /** Whether `.shogo/pool-dist` holds a placeholder-based build. */
  distBuilt: boolean
}

export function poolDistDir(root: string): string {
  return join(root, ...POOL_DIST_RELATIVE)
}

export function listRootEntries(root: string): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

/** Project folders are UUID-named; a pre-seed never creates one. */
const UUID_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isPreseedEntry(entry: string, excluded: ReadonlySet<string>): boolean {
  return (
    entry.length > 0 &&
    !entry.includes('/') &&
    !entry.includes('\\') &&
    entry !== '.' &&
    entry !== '..' &&
    !WORKSPACE_LEVEL_ENTRIES.has(entry) &&
    !UUID_ENTRY.test(entry) &&
    !excluded.has(entry)
  )
}

/**
 * `exclude` names root entries an assign may already have created by the
 * time a slow pre-seed finishes (attached project folders, linked mounts).
 */
export function writePoolPreseedManifest(
  root: string,
  input: {
    entriesBefore: readonly string[]
    techStackId: string | null
    distBuilt: boolean
    exclude?: readonly string[]
  },
): PoolPreseedManifest {
  const excluded = new Set([...input.entriesBefore, ...(input.exclude ?? [])])
  const manifest: PoolPreseedManifest = {
    entries: listRootEntries(root).filter((e) => isPreseedEntry(e, excluded)),
    techStackId: input.techStackId,
    distBuilt: input.distBuilt && existsSync(join(poolDistDir(root), 'index.html')),
  }
  mkdirSync(join(root, '.shogo'), { recursive: true })
  writeFileSync(join(root, ...MANIFEST_RELATIVE), JSON.stringify(manifest, null, 2))
  return manifest
}

export function readPoolPreseedManifest(root: string): PoolPreseedManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ...MANIFEST_RELATIVE), 'utf-8'))
    if (!parsed || !Array.isArray(parsed.entries)) return null
    const none = new Set<string>()
    return {
      entries: parsed.entries.filter((e: unknown): e is string => typeof e === 'string' && isPreseedEntry(e, none)),
      techStackId: typeof parsed.techStackId === 'string' ? parsed.techStackId : null,
      distBuilt: parsed.distBuilt === true,
    }
  } catch {
    return null
  }
}

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** Replace `from` with `to` in every text asset under `dir`. Returns files changed. */
export function rebaseDistAssets(dir: string, from: string, to: string): number {
  if (from === to || !existsSync(dir)) return 0
  let changed = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      changed += rebaseDistAssets(path, from, to)
    } else if (entry.isFile() && DIST_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      const text = readFileSync(path, 'utf-8')
      if (text.includes(from)) {
        writeFileSync(path, text.split(from).join(to))
        changed++
      }
    }
  }
  return changed
}

function movePath(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  try {
    renameSync(src, dest)
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true })
    rmSync(src, { recursive: true, force: true })
  }
}

/** Copy the runtime template's own copies of workspace-level files (e.g. its AGENTS.md). */
function copyTemplateWorkspaceLevelFiles(memberDir: string): void {
  const templatePath = getRuntimeTemplatePath()
  if (!templatePath) return
  for (const name of listRootEntries(templatePath)) {
    if (!WORKSPACE_LEVEL_ENTRIES.has(name) || TEMPLATE_COPY_SKIP.has(name)) continue
    const dest = join(memberDir, name)
    if (existsSync(dest)) continue
    cpSync(join(templatePath, name), dest, { recursive: true })
  }
}

export type AdoptResult =
  | { adopted: true; moved: string[]; distReady: boolean }
  | { adopted: false; reason: 'no-manifest' | 'member-has-source' | 'stack-mismatch' }

/**
 * Move the pool pre-seed from `root` into `memberDir` and serve its pre-built
 * dist under `basePath`. Refuses when the member already has source or wants a
 * different tech stack; the caller then seeds normally and discards the root.
 */
export function adoptPoolPreseedIntoMember(
  root: string,
  memberDir: string,
  opts: { basePath: string; techStackId?: string },
): AdoptResult {
  const manifest = readPoolPreseedManifest(root)
  if (!manifest) return { adopted: false, reason: 'no-manifest' }
  if (memberHasProjectSource(memberDir)) return { adopted: false, reason: 'member-has-source' }
  if (opts.techStackId && manifest.techStackId && opts.techStackId !== manifest.techStackId) {
    return { adopted: false, reason: 'stack-mismatch' }
  }

  mkdirSync(memberDir, { recursive: true })
  const moved: string[] = []
  for (const entry of manifest.entries) {
    const src = join(root, entry)
    if (!existsSync(src)) continue
    movePath(src, join(memberDir, entry))
    moved.push(entry)
  }

  const rootMarker = getInstallMarkerPath(root)
  if (existsSync(rootMarker)) {
    mkdirSync(join(memberDir, '.shogo'), { recursive: true })
    copyFileSync(rootMarker, getInstallMarkerPath(memberDir))
  }
  copyTemplateWorkspaceLevelFiles(memberDir)

  let distReady = false
  const pooledDist = poolDistDir(root)
  if (manifest.distBuilt && existsSync(join(pooledDist, 'index.html'))) {
    const dist = join(memberDir, 'dist')
    movePath(pooledDist, dist)
    rebaseDistAssets(dist, POOL_DIST_BASE_PLACEHOLDER, opts.basePath)
    writeFileSync(join(dist, POOL_TEMPLATE_DIST_MARKER), sha256File(join(dist, 'index.html')) ?? '')
    distReady = true
  }

  discardPoolPreseedArtifacts(root)
  return { adopted: true, moved, distReady }
}

/** Remove the pool manifest and pre-built dist, leaving the root app in place. */
export function discardPoolPreseedArtifacts(root: string): void {
  rmSync(join(root, ...MANIFEST_RELATIVE), { force: true })
  rmSync(poolDistDir(root), { recursive: true, force: true })
}

/** Delete every pool pre-seed entry from the workspace root. Returns what was removed. */
export function discardPoolPreseed(root: string): string[] {
  const manifest = readPoolPreseedManifest(root)
  if (!manifest) return []
  const removed: string[] = []
  for (const entry of manifest.entries) {
    const path = join(root, entry)
    if (!existsSync(path)) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(entry)
  }
  discardPoolPreseedArtifacts(root)
  return removed
}

/**
 * Drop an adopted template `dist/` that no build has replaced yet, so a
 * project restored over it rebuilds instead of serving the starter app.
 */
export function removePoolTemplateDist(dir: string): boolean {
  const dist = join(dir, 'dist')
  const markerPath = join(dist, POOL_TEMPLATE_DIST_MARKER)
  if (!existsSync(markerPath)) return false
  const expected = readFileSync(markerPath, 'utf-8').trim()
  const actual = sha256File(join(dist, 'index.html'))
  if (expected && actual === expected) {
    rmSync(dist, { recursive: true, force: true })
    return true
  }
  rmSync(markerPath, { force: true })
  return false
}
