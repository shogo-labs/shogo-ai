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
  lstatSync,
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

/**
 * Root entries that belong to the workspace itself, never to a project.
 * `.git` is the git layer's: it is seeded during the pre-seed but, once the
 * host adopts it, holds the project's durable repo, which must stay put.
 */
const WORKSPACE_LEVEL_ENTRIES = new Set(['.shogo', '.git', 'memory', ...Object.keys(DEFAULT_WORKSPACE_FILES)])

/** Workspace-level names the runtime template also ships a project copy of. */
const TEMPLATE_COPY_SKIP = new Set(['node_modules', '.shogo', '.git'])

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

/**
 * A symlink at the root is a linked mount or a project folder link — never
 * something the pre-seed creates — so it is never recorded and never removed.
 */
function isLinkedEntry(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

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
 *
 * Every other root entry is recorded, including ones that existed before the
 * pre-seed. A pool VM owns its whole root, so "it was already here" is not
 * evidence it is not the pool's: a metal VM resumed from a snapshot, a reused
 * `/data/workspace` drive and a container restart all boot with last boot's
 * pre-seeded app already in place, and subtracting those entries left an empty
 * manifest that let the template survive assignment (SHO-194).
 */
export function writePoolPreseedManifest(
  root: string,
  input: {
    techStackId: string | null
    distBuilt: boolean
    exclude?: readonly string[]
  },
): PoolPreseedManifest {
  const excluded = new Set(input.exclude ?? [])
  const manifest: PoolPreseedManifest = {
    entries: listRootEntries(root).filter(
      (e) => isPreseedEntry(e, excluded) && !isLinkedEntry(join(root, e)),
    ),
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
    if (!existsSync(src) || isLinkedEntry(src)) continue
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
    if (!existsSync(path) || isLinkedEntry(path)) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(entry)
  }
  discardPoolPreseedArtifacts(root)
  return removed
}

/**
 * Root app artifacts that name no template file because the pre-seed's install
 * and build steps create them: `node_modules` and `dist` are installed/built,
 * `server.tsx` is generated by `shogo generate`, and `prisma/dev.db*` is pushed
 * by the preview pipeline.
 */
const APP_ARTIFACT_ENTRIES = new Set(['node_modules', 'dist', 'server.tsx'])
const APP_ARTIFACT_PREFIXES = ['prisma/dev.db'] as const

/**
 * The root entries a manifest-less cleanup may remove: the runtime template's
 * own top-level names (minus workspace-level files the template also ships,
 * e.g. its `AGENTS.md`) plus the generated app artifacts above.
 *
 * Anything else — `research/`, `plans/`, `files/`, an attached project folder,
 * a linked mount — is not a template name and therefore survives.
 */
export function removableTemplateRootEntries(): string[] {
  const templatePath = getRuntimeTemplatePath()
  if (!templatePath) return []
  const names = listRootEntries(templatePath).filter((entry) => !WORKSPACE_LEVEL_ENTRIES.has(entry))
  return [...names, ...APP_ARTIFACT_ENTRIES].sort()
}

/** Whether `root` still carries the runtime template's install marker or package name. */
export function rootCarriesRuntimeTemplate(root: string): boolean {
  if (existsSync(getInstallMarkerPath(root))) return true
  const templatePath = getRuntimeTemplatePath()
  if (!templatePath) return false
  try {
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
    const templatePkg = JSON.parse(readFileSync(join(templatePath, 'package.json'), 'utf-8'))
    return typeof rootPkg?.name === 'string' && rootPkg.name === templatePkg?.name
  } catch {
    return false
  }
}

/** `package.json` + `src/` at `dir` — the shape of a real app, seeded or user-written. */
export function rootHasAppSource(root: string): boolean {
  return existsSync(join(root, 'package.json')) && existsSync(join(root, 'src'))
}

/**
 * Fallback for an assign whose manifest is missing or empty: remove only the
 * entries that carry the runtime template's own names. Used when the pre-seed
 * ran on a root that already held last boot's pre-seed (a resumed metal
 * snapshot, a reused drive), which the manifest cannot describe.
 */
export function discardRuntimeTemplateFromRoot(root: string): string[] {
  if (!rootCarriesRuntimeTemplate(root)) return []
  const removable = new Set(removableTemplateRootEntries())
  const removed: string[] = []
  for (const entry of listRootEntries(root)) {
    const path = join(root, entry)
    if (isLinkedEntry(path)) continue
    if (APP_ARTIFACT_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true })
        removed.push(entry)
      }
      continue
    }
    if (!removable.has(entry)) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(entry)
  }
  discardPoolPreseedArtifacts(root)
  return removed
}

export type RootCleanupResult =
  | { source: 'manifest' | 'template'; removed: string[] }
  | { source: 'none'; removed: []; why: 'resumed-runtime' | 'no-template' | 'nothing-to-remove' }

/**
 * Clear the pool's app out of a workspace runtime's root.
 *
 * Deletion is allowed only when this process pre-seeded the root itself
 * (`bootedFromPool`: it booted as an unassigned pool VM and is now being
 * assigned), because then the root can hold nothing but the pool's own work.
 * A workspace runtime that booted already assigned — a resume, a hydrate, a
 * host-pool assignment the API prepared — may have user work in its root, so it
 * only reports it (SHO-194: a portfolio built into the root must not vanish on
 * the next boot).
 */
export function discardPoolPreseedAtAssign(
  root: string,
  opts: { bootedFromPool: boolean },
): RootCleanupResult {
  if (!opts.bootedFromPool) {
    if (rootHasAppSource(root)) {
      console.error(
        '[agent-runtime] Workspace root still carries an app (package.json + src/) on a resumed runtime — leaving it alone, it may be user work',
      )
    }
    console.log('[agent-runtime] Workspace runtime: no pool pre-seed in this process — not removing anything from the workspace root')
    return { source: 'none', removed: [], why: 'resumed-runtime' }
  }
  const removed = discardPoolPreseed(root)
  if (removed.length) return { source: 'manifest', removed }
  // No manifest, or one that lists nothing: last boot's pre-seed was already in
  // the root when this boot's pre-seed ran, so the manifest cannot describe it.
  // Remove only entries carrying the runtime template's own names, so anything
  // a project or the user created (`research/`, project folders, mounts)
  // survives.
  if (!rootCarriesRuntimeTemplate(root)) return { source: 'none', removed: [], why: 'no-template' }
  const fallbackRemoved = discardRuntimeTemplateFromRoot(root)
  if (fallbackRemoved.length) return { source: 'template', removed: fallbackRemoved }
  return { source: 'none', removed: [], why: 'nothing-to-remove' }
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
