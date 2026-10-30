// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * File sources for a workspace archive.
 *
 * Two very different layouts have to produce the *same* archive:
 *
 *   desktop  `<workspacesDir>/.workspace-roots/<rootName>/` — real workspace
 *            files (AGENTS.md, memory/, .shogo/*) plus a **symlink per
 *            project**, with the project trees themselves in
 *            `<workspacesDir>/<projectId>/`.
 *   cloud    the workspace pod's `WORKSPACE_DIR` — the project trees are real
 *            sibling directories, not links.
 *
 * A walker that only follows `isDirectory()` silently drops every project on
 * desktop; one that follows links unconditionally duplicates every project on
 * cloud. So the workspace-root walk skips any entry that is a project id of
 * this workspace *or* a symlink that resolves into one, and projects are read
 * once through {@link collectExportWorkspaceFiles}.
 *
 * `<rootName>` is `<workspaceId>` for a workspace-session runtime
 * (`RuntimeManager.startWorkspace`) and `proj-<anchorProjectId>` for a
 * project-anchored one (`startProjectWorkspace`). A user can have both, so the
 * root is resolved, never guessed — see {@link resolveWorkspaceRoot}.
 */

import { AgentClient, type WorkspaceBundle } from '@shogo-ai/sdk/agent'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { importCloudModule } from '../../lib/cloud-import'
import { deriveProjectRuntimeToken } from '../../lib/project-runtime-token'

const PROJECT_ROOT = resolve(import.meta.dir, '../../../../..')

export function workspacesDir(): string {
  return process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
}

export const isKubernetes = (): boolean => !!process.env.KUBERNETES_SERVICE_HOST

/** Per-file cap for anything that travels in an archive. */
export const MAX_FILE_SIZE = 10 * 1024 * 1024

/**
 * macOS detritus: `._*` AppleDouble sidecars crash Metro's Babel parser, and a
 * stray `__MACOSX` folder is never project content. Declared here rather than
 * imported from `@shogo/shared-runtime` so this service has no dependency a
 * test would have to mock.
 */
export const isMacOsJunk = (name: string): boolean =>
  name === '__MACOSX' || name.startsWith('._')

// `dist/` and `build/` are intentionally NOT excluded here — a bundle carries
// the prebuilt app output so an imported project can serve its preview
// immediately (preview-manager treats `project/dist/index.html` as "ready").
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.expo',
])

// Volatile, per-machine or generated files a portable archive never carries:
//   *-wal / *-shm  SQLite write-ahead log + shared memory (the `.db` ships
//                  on its own; the sidecars can be inconsistent).
//   .install-ok*   per-machine install-state markers.
//   .shogo-cwd-*   transient shell-cwd markers leaked from preview tooling.
export const EXCLUDED_FILE_PATTERNS: RegExp[] = [
  /-wal$/i,
  /-shm$/i,
  /^\.install-ok/,
  /^\.shogo-cwd-/,
]

// `.shogo/install-marker` is sha256(package.json) recorded after the
// exporter's last successful install. Trusting it on a fresh machine makes
// `ensureWorkspaceDeps` skip the install and leaves the seeded `node_modules`
// in place for a different stack (the "imported Expo never rebuilds" report).
export const EXCLUDED_RELATIVE_PATHS = new Set<string>(['.shogo/install-marker'])

export const isExcludedFile = (name: string): boolean =>
  EXCLUDED_FILE_PATTERNS.some((re) => re.test(name))

/**
 * Path-aware exclusion check: `.shogo/install-marker` is excluded by full
 * relative path, everything else by basename.
 */
export const isExcludedRelPath = (relPath: string): boolean => {
  if (EXCLUDED_RELATIVE_PATHS.has(relPath)) return true
  // The marker matters wherever it sits: a project's own marker has the same
  // effect (and the same skew risk) as the workspace root's.
  for (const excluded of EXCLUDED_RELATIVE_PATHS) {
    if (relPath.endsWith(`/${excluded}`)) return true
  }
  const baseName = relPath.split('/').pop() || ''
  return isExcludedFile(baseName)
}

export type SkippedFile = { path: string; reason: string }

/**
 * Recursively collect `dir` into `relPath -> bytes`.
 *
 * Symlinks are followed only when their realpath stays inside `baseDir`, so a
 * project tree can link to a sibling inside itself but never escape into
 * another project's directory. Anything else is recorded in `skipped`.
 */
export function collectWorkspaceFiles(
  dir: string,
  baseDir: string,
  skipped: SkippedFile[] = [],
  extraExcludedDirs?: ReadonlySet<string>,
): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  if (!existsSync(dir)) return files

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err: any) {
    skipped.push({ path: relative(baseDir, dir), reason: `readdir-error:${err?.message || 'unknown'}` })
    return files
  }

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    if (extraExcludedDirs?.has(entry.name)) continue
    if (isMacOsJunk(entry.name)) continue

    const fullPath = join(dir, entry.name)
    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/')
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()

    if (entry.isSymbolicLink()) {
      // `readdirSync(withFileTypes)` reports a symlink as neither dir nor file.
      let target: string
      try {
        target = realpathSync(fullPath)
      } catch {
        skipped.push({ path: relPath, reason: 'broken-symlink' })
        continue
      }
      const rootReal = realpathSync(baseDir)
      if (target !== rootReal && !target.startsWith(rootReal + '/')) {
        skipped.push({ path: relPath, reason: 'symlink-outside-root' })
        continue
      }
      try {
        const st = statSync(fullPath)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        skipped.push({ path: relPath, reason: 'unreadable-symlink' })
        continue
      }
      // A symlink that points at a directory loops back into the same walk,
      // so only follow it when it is not one of the excluded names above.
    }

    if (isDir) {
      Object.assign(files, collectWorkspaceFiles(fullPath, baseDir, skipped, extraExcludedDirs))
    } else if (isFile) {
      if (isExcludedRelPath(relPath)) {
        skipped.push({ path: relPath, reason: 'excluded-pattern' })
        continue
      }
      try {
        const stat = statSync(fullPath)
        if (stat.size > MAX_FILE_SIZE) {
          skipped.push({ path: relPath, reason: `size>${MAX_FILE_SIZE}` })
          continue
        }
        files[relPath] = new Uint8Array(readFileSync(fullPath))
      } catch (err: any) {
        skipped.push({ path: relPath, reason: `read-error:${err?.message || 'unknown'}` })
      }
    }
  }
  return files
}

// Retries against a freshly resolved runtime URL. On metal the controller
// caches a runtime's URL for a few seconds, and a microVM that suspended or
// moved in that window refuses connections until the cache is dropped.
const DEFAULT_RUNTIME_BUNDLE_RETRY_DELAYS_MS = [500, 1500, 3000]
let runtimeBundleRetryDelaysMs = DEFAULT_RUNTIME_BUNDLE_RETRY_DELAYS_MS

export function _setRuntimeBundleRetryDelaysForTests(delays: number[] | null): void {
  runtimeBundleRetryDelaysMs = delays ?? DEFAULT_RUNTIME_BUNDLE_RETRY_DELAYS_MS
}

async function invalidateMetalRuntimeUrl(projectId: string): Promise<void> {
  const { isMetalEnabled } = await import('../../lib/metal-eligibility')
  if (!isMetalEnabled()) return
  const { getMetalWarmPoolController, workspaceRuntimeKey } =
    await importCloudModule<typeof import('../../lib/metal-warm-pool-controller')>(
      './metal-warm-pool-controller',
    )
  getMetalWarmPoolController().invalidateUrlCache(workspaceRuntimeKey('', projectId))
}

export async function fetchRuntimeWorkspaceBundle(projectId: string): Promise<WorkspaceBundle> {
  // Kubernetes-only: load through importCloudModule so the desktop bundle
  // (which mounts this router) doesn't pull in the Knative/warm-pool graph.
  const { getProjectPodUrl } =
    await importCloudModule<typeof import('../../lib/knative-project-manager')>(
      './knative-project-manager',
    )
  let lastError: unknown
  for (let attempt = 0; attempt <= runtimeBundleRetryDelaysMs.length; attempt++) {
    if (attempt > 0) {
      await invalidateMetalRuntimeUrl(projectId).catch(() => {})
      await new Promise((r) => setTimeout(r, runtimeBundleRetryDelaysMs[attempt - 1]))
    }
    try {
      const podUrl = await getProjectPodUrl(projectId)
      // Pod-side workspace endpoints require the per-project runtime token.
      // `project` scope bundles the project's own folder rather than a
      // workspace runtime's merged root.
      const agent = new AgentClient({
        baseUrl: podUrl,
        headers: { 'x-runtime-token': await deriveProjectRuntimeToken(projectId) },
        workspaceScope: 'project',
      })
      return await agent.getWorkspaceBundle()
    } catch (err) {
      lastError = err
      console.warn(
        `[Export] Workspace bundle attempt ${attempt + 1} for ${projectId} failed: ${(err as any)?.message ?? err}`,
      )
    }
  }
  throw lastError
}

/**
 * Collect a project's workspace files, transparently sourcing them from the
 * live agent pod (Kubernetes, via `/agent/workspace/bundle`) or from local
 * disk (`WORKSPACES_DIR`). Returns flat project-relative paths. Shared by the
 * project bundle, the source-only ZIP and the workspace archive so all three
 * agree on provenance, exclusions and k8s behaviour.
 */
export async function collectExportWorkspaceFiles(
  projectId: string,
  opts: { extraExcludedDirs?: Set<string>; workspaceDir?: string } = {},
): Promise<{
  files: Record<string, Uint8Array>
  sourceMode: 'k8s' | 'k8s-fallback-empty' | 'local'
  fileSkipped: SkippedFile[]
  warnings: string[]
}> {
  const files: Record<string, Uint8Array> = {}
  const fileSkipped: SkippedFile[] = []
  const warnings: string[] = []
  let sourceMode: 'k8s' | 'k8s-fallback-empty' | 'local' = 'local'

  const extra = opts.extraExcludedDirs
  const hasExcludedSegment = (relPath: string): boolean =>
    !!extra && extra.size > 0 && relPath.split('/').some((seg) => extra.has(seg))

  if (isKubernetes()) {
    sourceMode = 'k8s'
    try {
      const bundle = await fetchRuntimeWorkspaceBundle(projectId)
      const bundleFiles =
        bundle && typeof bundle === 'object' && bundle.files && typeof bundle.files === 'object'
          ? bundle.files
          : {}
      if (Object.keys(bundleFiles).length === 0) {
        warnings.push(
          'Runtime pod returned an empty workspace bundle; the agent may be cold-starting or have no files yet.',
        )
      }

      // Defensive normalisation: older runtime pods returned backslash paths
      // which, zipped verbatim, became literal-backslash filenames.
      let backslashCount = 0
      for (const [rawRelPath, base64Data] of Object.entries(bundleFiles)) {
        const relPath = rawRelPath.replace(/\\/g, '/')
        if (relPath !== rawRelPath) backslashCount++
        if (isExcludedRelPath(relPath) || hasExcludedSegment(relPath)) {
          fileSkipped.push({ path: relPath, reason: 'excluded-pattern' })
          continue
        }
        files[relPath] = new Uint8Array(Buffer.from(base64Data, 'base64'))
      }
      if (backslashCount > 0) {
        warnings.push(
          `Runtime pod returned ${backslashCount} workspace path(s) with backslash separators; normalised on the API side. The pod build may be outdated.`,
        )
      }
    } catch (err: any) {
      sourceMode = 'k8s-fallback-empty'
      warnings.push(
        `Could not reach agent pod for workspace files: ${err?.message || 'unknown error'}`,
      )
      console.warn(`[Export] Could not reach agent pod for workspace files: ${err.message}`)
    }
  } else {
    const workspaceDir = opts.workspaceDir || join(workspacesDir(), projectId)
    const workspaceFiles = collectWorkspaceFiles(
      workspaceDir,
      workspaceDir,
      fileSkipped,
      opts.extraExcludedDirs,
    )
    for (const [relPath, data] of Object.entries(workspaceFiles)) {
      files[relPath] = data
    }
  }

  return { files, sourceMode, fileSkipped, warnings }
}

export interface WorkspaceRootResolution {
  /** Directory to walk, or null when nothing on this surface holds workspace files. */
  dir: string | null
  /** Every candidate that existed, newest first. */
  candidates: string[]
  warnings: string[]
}

function newestFirst(dirs: string[]): string[] {
  return [...dirs].sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs
    } catch {
      return 0
    }
  })
}

/**
 * Resolve the merged workspace root for `workspaceId`.
 *
 * 1. `.workspace-roots/<workspaceId>` — a workspace-session runtime.
 * 2. Every `.workspace-roots/proj-*` whose link set covers one of this
 *    workspace's project ids — a project-anchored runtime.
 * 3. If more than one exists, the newest wins and both paths are recorded in
 *    `warnings`. Two roots are never merged: every workspace file would land
 *    in the archive twice.
 */
export function resolveWorkspaceRoot(
  workspaceId: string,
  projectIds: readonly string[],
  baseDir: string = workspacesDir(),
): WorkspaceRootResolution {
  const rootsDir = join(baseDir, '.workspace-roots')
  const warnings: string[] = []
  const found: string[] = []
  if (!existsSync(rootsDir)) {
    return { dir: null, candidates: [], warnings }
  }

  const byId = join(rootsDir, workspaceId)
  if (existsSync(byId)) found.push(byId)

  const projectIdSet = new Set(projectIds)
  let entries: string[] = []
  try {
    entries = readdirSync(rootsDir)
  } catch {
    entries = []
  }
  for (const name of entries) {
    if (!name.startsWith('proj-')) continue
    const dir = join(rootsDir, name)
    if (!projectIdSet.size) continue
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    if (names.some((n) => projectIdSet.has(n))) found.push(dir)
  }

  const ranked = newestFirst(found)
  if (ranked.length > 1) {
    warnings.push(
      `Several workspace roots exist for this workspace (${ranked.join(', ')}); exported the newest (${ranked[0]}). They are never merged — that would duplicate every workspace file.`,
    )
  }
  return { dir: ranked[0] ?? null, candidates: ranked, warnings }
}

/**
 * Workspace-level files only: the root's own files (AGENTS.md, MEMORY.md,
 * TOOLS.md, HEARTBEAT.md, memory/, .shogo/{skills,agents,plans,tasks}) with
 * every project entry dropped, whether it is a project id, a `proj-` link or a
 * symlink resolving into a project directory.
 */
export function collectWorkspaceRootFiles(
  rootDir: string,
  projectIds: readonly string[],
  skipped: SkippedFile[] = [],
  extraExcludedNames: ReadonlySet<string> = new Set(),
  projectsBaseDir: string = workspacesDir(),
): Record<string, Uint8Array> {
  const projectIdSet = new Set(projectIds)
  const files: Record<string, Uint8Array> = {}
  if (!existsSync(rootDir)) return files

  let entries
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
  } catch (err: any) {
    skipped.push({ path: '.', reason: `readdir-error:${err?.message || 'unknown'}` })
    return files
  }

  const rootReal = (() => {
    try {
      return realpathSync(rootDir)
    } catch {
      return rootDir
    }
  })()
  const projectReals = new Set<string>()
  for (const id of projectIds) {
    const projDir = join(projectsBaseDir, id)
    if (existsSync(projDir)) {
      try {
        projectReals.add(realpathSync(projDir))
      } catch {
        /* ignore */
      }
    }
  }

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    if (extraExcludedNames.has(entry.name)) continue
    if (isMacOsJunk(entry.name)) continue
    if (entry.name === '.workspace-roots') continue
    if (projectIdSet.has(entry.name)) continue

    const fullPath = join(rootDir, entry.name)
    const relPath = relative(rootDir, fullPath).replace(/\\/g, '/')

    if (entry.isSymbolicLink()) {
      let target: string | null = null
      try {
        target = realpathSync(fullPath)
      } catch {
        skipped.push({ path: relPath, reason: 'broken-symlink' })
        continue
      }
      if (
        target === rootReal ||
        projectReals.has(target) ||
        projectIdSet.has(target.split('/').pop() || '') ||
        !target.startsWith(rootReal + '/')
      ) {
        // A project link (desktop) or anything pointing outside the root.
        skipped.push({ path: relPath, reason: 'project-or-outside-root' })
        continue
      }
    } else if (entry.isDirectory() && projectIdSet.has(entry.name)) {
      // Cloud: real sibling directory named after a project.
      skipped.push({ path: relPath, reason: 'project-dir' })
      continue
    }

    if (entry.isFile()) {
      if (isExcludedRelPath(relPath)) {
        skipped.push({ path: relPath, reason: 'excluded-pattern' })
        continue
      }
      try {
        const stat = statSync(fullPath)
        if (stat.size > MAX_FILE_SIZE) {
          skipped.push({ path: relPath, reason: `size>${MAX_FILE_SIZE}` })
          continue
        }
        files[relPath] = new Uint8Array(readFileSync(fullPath))
      } catch (err: any) {
        skipped.push({ path: relPath, reason: `read-error:${err?.message || 'unknown'}` })
      }
      continue
    }

    // A directory (or a link that resolves into one inside the root).
    Object.assign(files, collectWorkspaceFiles(fullPath, rootDir, skipped, extraExcludedNames))
  }
  return files
}

/**
 * Workspace-level files from the live namespace pod (cloud only).
 *
 * The workspace pod roots a merged runtime at `WORKSPACE_DIR` where projects
 * are real sibling directories, so the project ids are filtered out here the
 * same way they are on desktop.
 */
export async function collectWorkspacePodFiles(
  workspaceId: string,
  projectIds: readonly string[],
  skipped: SkippedFile[] = [],
): Promise<{ files: Record<string, Uint8Array>; warnings: string[] }> {
  const warnings: string[] = []
  const files: Record<string, Uint8Array> = {}
  if (!isKubernetes()) return { files, warnings }

  try {
    const [{ getWorkspacePodUrl }, { deriveWorkspaceRuntimeToken }] = await Promise.all([
      importCloudModule<typeof import('../../lib/knative-workspace-manager')>(
        './knative-workspace-manager',
      ),
      import('../../lib/workspace-runtime-token'),
    ])
    const podUrl = await getWorkspacePodUrl(workspaceId, [...projectIds])
    const agent = new AgentClient({
      baseUrl: podUrl,
      headers: { 'x-runtime-token': deriveWorkspaceRuntimeToken(workspaceId) },
    })
    const bundle: WorkspaceBundle = await agent.getWorkspaceBundle()
    const bundleFiles =
      bundle && typeof bundle === 'object' && bundle.files && typeof bundle.files === 'object'
        ? bundle.files
        : {}
    const projectIdSet = new Set(projectIds)
    for (const [rawPath, base64] of Object.entries(bundleFiles)) {
      const relPath = rawPath.replace(/\\/g, '/')
      const top = relPath.split('/')[0]
      if (projectIdSet.has(top)) {
        skipped.push({ path: relPath, reason: 'project-dir' })
        continue
      }
      if (isExcludedRelPath(relPath)) {
        skipped.push({ path: relPath, reason: 'excluded-pattern' })
        continue
      }
      files[relPath] = new Uint8Array(Buffer.from(base64, 'base64'))
    }
    if (!Object.keys(files).length) {
      warnings.push('The workspace runtime returned an empty workspace bundle.')
    }
  } catch (err: any) {
    warnings.push(`Could not read workspace files from the runtime pod: ${err?.message || 'unknown error'}`)
  }
  return { files, warnings }
}

/**
 * A folder-linked project with no runtime keeps its code in `ProjectFolder.path`
 * on this machine; read it when it is local and readable.
 */
export function collectFolderLinkedFiles(
  path: string,
  skipped: SkippedFile[] = [],
): Record<string, Uint8Array> {
  if (!path || !existsSync(path)) return {}
  try {
    if (!lstatSync(path).isDirectory()) return {}
  } catch {
    return {}
  }
  return collectWorkspaceFiles(path, path, skipped)
}
