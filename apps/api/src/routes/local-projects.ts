// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local Projects Routes (Shogo Desktop / `SHOGO_LOCAL_MODE=true` only).
 *
 * Implements the VS Code-style "Open Folder" project model:
 * - `workingMode = 'external'` projects point at one or more host folders.
 * - The project's `.shogo/` directory lives inside the primary folder
 *   (alongside the user's code), mirroring `.vscode/`, `.idea/`, `.cursor/`,
 *   `.claude/`. Personal/runtime state lives under `.shogo/local/`, which
 *   is the only thing we ever add to the user's `.gitignore`.
 * - Folder identity is keyed by `<primary>/.shogo/project.json#projectId`
 *   so rebinding a folder on a different machine round-trips to the same
 *   `Project` row.
 *
 * These routes are mounted in `apps/api/src/server.ts` only when
 * `SHOGO_LOCAL_MODE=true` (next to `vmRoutes()`). They are not exposed in
 * the cloud build.
 */

import { Hono } from 'hono'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { cpSync } from 'fs'
import { dirname, isAbsolute, join, resolve, sep } from 'path'
import os from 'os'
import { prisma } from '../lib/prisma'

// =============================================================================
// Runtime pre-warm
// =============================================================================
//
// The agent-runtime is a Bun subprocess that has to load thousands of
// TypeScript modules on cold start (~25–30 s on a typical Mac laptop —
// see RuntimeManager.waitForAgentReady's 50 × 500 ms budget). When the
// user picks a folder, the frontend lands on the project page and
// immediately polls `/agent/chat/:cid/turn`, `/agent/quick-actions`,
// etc. Each of those proxies hits `getProjectUrl` which awaits
// `manager.start()`. The first poll triggers the spawn; subsequent
// polls hit `waitForRuntimeReady` (30 s timeout) and warn with
// `Timeout waiting for runtime <id> to become ready` if the agent
// hasn't bound /health within that window.
//
// Kicking the start off the moment we return the `Project` row buys
// the runtime ~the round-trip-to-frontend + first-poll-interval head
// start (typically 200–1000 ms) — enough that the second poll usually
// arrives after the agent has bound /health and the warning never
// fires.
//
// Fire-and-forget: we never await the promise (`start()` only resolves
// when the runtime is fully ready, which is up to 30 s). Errors are
// logged but don't fail the API response — the user can still see
// their project in the dashboard even if the runtime can't start.
function prewarmRuntimeBackground(projectId: string, hint: string): void {
  // Async-import the manager so we never crash a route on a module
  // resolution failure. Local-only mount, but defensive nonetheless.
  import('../lib/runtime/manager')
    .then(({ getRuntimeManager }) => {
      try {
        const manager = getRuntimeManager()
        // start() deduplicates concurrent calls on the same projectId
        // via `startingPromises`, so this is safe even if the user is
        // racing the chat panel's own start() call.
        manager.start(projectId).catch((err: any) => {
          console.warn(
            `[local-projects] prewarm: runtime start for ${projectId} (${hint}) failed: ${err?.message ?? err}`,
          )
        })
        console.log(`[local-projects] prewarm: kicked off runtime for ${projectId} (${hint})`)
      } catch (err: any) {
        console.warn(`[local-projects] prewarm: getRuntimeManager threw: ${err?.message ?? err}`)
      }
    })
    .catch((err) => {
      console.warn(`[local-projects] prewarm: import of runtime/manager failed: ${err?.message ?? err}`)
    })
}

// =============================================================================
// Constants
// =============================================================================

const SHOGO_DIR = '.shogo'
const PROJECT_JSON = 'project.json'
const LOCAL_DIR = 'local'
const SCHEMA_VERSION = 1
const GITIGNORE_ENTRY = '.shogo/local/'
// Marker comment we write into .gitignore right before our entry so the
// user can see who added it. Matches the convention used by tools like
// husky / .vscode that touch shared dotfiles.
const GITIGNORE_COMMENT = '# Shogo — IDE-mode local state (safe to ignore)'

// Folders we refuse to bind even if technically a directory. Catches the
// most obvious "user picked their entire home / root" mistakes; the agent
// path-guard in packages/agent-runtime/src/gateway-tools.ts is the real
// defense, but failing fast here gives a useful error in the UI.
const FORBIDDEN_ROOTS = new Set(
  process.platform === 'win32'
    ? ['C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
    : ['/', '/etc', '/usr', '/bin', '/sbin', '/var', '/System', '/Library', '/Applications'],
)

// =============================================================================
// project.json contract
// =============================================================================

interface ProjectJson {
  projectId: string
  createdAt: string
  schemaVersion: number
}

function readProjectJson(folderPath: string): ProjectJson | null {
  const p = join(folderPath, SHOGO_DIR, PROJECT_JSON)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ProjectJson>
    if (typeof raw?.projectId !== 'string' || !raw.projectId) return null
    return {
      projectId: raw.projectId,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : SCHEMA_VERSION,
    }
  } catch (err) {
    console.warn(`[local-projects] Corrupt project.json at ${p}:`, err)
    return null
  }
}

function writeProjectJson(folderPath: string, projectId: string): void {
  const shogoDir = join(folderPath, SHOGO_DIR)
  mkdirSync(shogoDir, { recursive: true })
  mkdirSync(join(shogoDir, 'skills'), { recursive: true })
  mkdirSync(join(shogoDir, 'plans'), { recursive: true })
  mkdirSync(join(shogoDir, LOCAL_DIR), { recursive: true })
  const data: ProjectJson = {
    projectId,
    createdAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
  }
  writeFileSync(join(shogoDir, PROJECT_JSON), JSON.stringify(data, null, 2), 'utf-8')
}

// Append `.shogo/local/` to `<folder>/.gitignore` iff:
//   - The folder is inside a git repo (has `.git` somewhere up the tree), AND
//   - The entry isn't already present (idempotent — safe on every boot).
// We never CREATE a `.gitignore` from scratch in a non-git directory: doing
// so would suggest the user is using git when they aren't, which is the
// VS Code "principle of least pollution" we settled on in the plan.
function ensureGitignoreEntry(folderPath: string): void {
  if (!findGitRoot(folderPath)) return
  const gitignorePath = join(folderPath, '.gitignore')
  let current = ''
  if (existsSync(gitignorePath)) {
    try {
      current = readFileSync(gitignorePath, 'utf-8')
    } catch (err) {
      console.warn(`[local-projects] Could not read ${gitignorePath}:`, err)
      return
    }
  }
  // Accept any of the obvious variants the user might already have.
  const variants = ['.shogo/local/', '.shogo/local', '/.shogo/local/', '/.shogo/local']
  const lines = current.split(/\r?\n/).map((l) => l.trim())
  if (lines.some((l) => variants.includes(l))) return

  const sep = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  const block = `${sep}\n${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}\n`
  try {
    writeFileSync(gitignorePath, current + block, 'utf-8')
  } catch (err) {
    console.warn(`[local-projects] Could not write ${gitignorePath}:`, err)
  }
}

// =============================================================================
// Path validation
// =============================================================================

function isUnderHome(p: string): boolean {
  const home = os.homedir()
  if (!home) return false
  const resolved = resolve(p)
  // startsWith with a trailing sep guard prevents `/Users/russe2` from
  // looking like a prefix of `/Users/russell` when home is the latter.
  return resolved === home || resolved.startsWith(home + sep)
}

function isForbiddenRoot(p: string): boolean {
  const resolved = resolve(p).replace(/[\\/]+$/, '') || '/'
  return FORBIDDEN_ROOTS.has(resolved)
}

interface ValidatedPath {
  ok: boolean
  path?: string
  error?: string
  code?: 'not_found' | 'not_directory' | 'outside_home' | 'forbidden_root' | 'not_absolute'
}

function validatePath(raw: string): ValidatedPath {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, error: 'Empty path', code: 'not_found' }
  }
  if (!isAbsolute(raw)) {
    return { ok: false, error: `Path must be absolute: ${raw}`, code: 'not_absolute' }
  }
  const resolved = resolve(raw)
  if (!existsSync(resolved)) {
    return { ok: false, error: `Folder does not exist: ${resolved}`, code: 'not_found' }
  }
  let s
  try {
    s = statSync(resolved)
  } catch (err: any) {
    return { ok: false, error: `Cannot stat ${resolved}: ${err.message}`, code: 'not_found' }
  }
  if (!s.isDirectory()) {
    return { ok: false, error: `Not a directory: ${resolved}`, code: 'not_directory' }
  }
  if (isForbiddenRoot(resolved)) {
    return { ok: false, error: `Refusing to bind sensitive system path: ${resolved}`, code: 'forbidden_root' }
  }
  if (!isUnderHome(resolved)) {
    return { ok: false, error: `Folder must be under your home directory: ${resolved}`, code: 'outside_home' }
  }
  return { ok: true, path: resolved }
}

// =============================================================================
// Git-root walk-up
// =============================================================================

// Returns the absolute path of the enclosing git repo root, or null.
// Implementation note: we walk upward via `.git` existence rather than
// shelling out to `git`, so this works on a machine without git
// installed (the agent still won't be able to commit, but binding
// works). `.git` can be a directory (normal repo) or a file (submodule /
// worktree); both count.
function findGitRoot(folderPath: string): string | null {
  let cur = resolve(folderPath)
  // Bound the walk to keep an accidental symlink loop from spinning.
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

// =============================================================================
// Routes
// =============================================================================

interface CreateFromFoldersBody {
  name?: string
  workspaceId?: string
  paths?: string[]
  /**
   * When the picked path is inside a git repo, the first call returns
   * `409 needsGitRootChoice`. The UI then re-calls with the user's
   * choice: `acceptedGitRoot: true` swaps the picked path for the repo
   * root; `acceptedGitRoot: false` proceeds with the original
   * subdirectory. Either is acceptable, we just need explicit consent.
   */
  acceptedGitRoot?: boolean
}

export function localProjectsRoutes(): Hono {
  const router = new Hono()

  /**
   * GET /fs/browse?path=<absolute>&includeFiles=<bool>&showHidden=<bool>
   *
   * Mounted at `/api/local/projects/fs/browse` (alongside the other
   * local-projects routes — the picker is only ever used to feed
   * `POST /from-folders`).
   *
   * Server-side directory listing for the in-app folder picker — the
   * standard pattern (JupyterLab's `FileDialog.getExistingDirectory`,
   * jupyter-host-file-picker) used when the browser can't return
   * absolute paths and the backend runs on the same machine as the
   * picker. In Shogo's case `SHOGO_LOCAL_MODE=true` is the gate that
   * makes "API process == user's machine" true.
   *
   * Safety:
   *   - Uses `validatePath` (same gauntlet as POST /from-folders): must
   *     be absolute, must exist, must be a directory, must be under
   *     `$HOME`, must not be a system root.
   *   - Realpaths the resolved path BEFORE listing so a symlink that
   *     escapes `$HOME` is rejected even if the link itself sits under
   *     `$HOME`.
   *   - Per-entry symlink status is exposed (`isSymlink`) so the UI can
   *     warn before descending, but we don't follow them in this
   *     listing — that's the agent-runtime trust layer's job once the
   *     project is bound.
   *
   * Caps the entry count at 1000; this keeps `node_modules` /
   * `Downloads` browsable but prevents an accidental huge directory
   * (e.g. the user's `~/Library/Caches/...`) from streaming megabytes
   * to the renderer. The UI shows a "truncated" hint when this trips.
   */
  router.get('/fs/browse', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)

    const home = os.homedir()
    const requested = c.req.query('path')
    const includeFiles = c.req.query('includeFiles') === 'true'
    // `showHidden` is informational for the API — we always include
    // dot-files in the response and tag them with `hidden: true`; the
    // client decides whether to render them. Kept as a query param so
    // it shows up in server-side telemetry alongside the path.
    void c.req.query('showHidden')

    // Default to $HOME when the client passes nothing. This keeps the
    // first request after opening the modal a single round-trip.
    const target = requested && requested.length > 0 ? requested : home

    const validated = validatePath(target)
    if (!validated.ok || !validated.path) {
      return c.json({ error: validated.error, code: validated.code }, 400)
    }

    // Realpath defeats symlink escapes. We then re-check the post-link
    // path is still under $HOME — symlink could otherwise point at /etc.
    let real: string
    try {
      real = realpathSync(validated.path)
    } catch (err: any) {
      return c.json(
        { error: `Cannot resolve real path: ${err?.message ?? String(err)}`, code: 'not_found' },
        400,
      )
    }
    if (!isUnderHome(real)) {
      return c.json(
        {
          error: `Folder resolves outside your home directory (symlink): ${real}`,
          code: 'outside_home',
        },
        400,
      )
    }
    if (isForbiddenRoot(real)) {
      return c.json(
        { error: `Refusing to browse sensitive system path: ${real}`, code: 'forbidden_root' },
        400,
      )
    }

    // Parent: null when we're at $HOME (no "up" past home) so the UI's
    // Up button can be disabled. Same rule the picker walks down from.
    const parent = real === home ? null : dirname(real)

    const MAX_ENTRIES = 1000
    let rawEntries: import('fs').Dirent[]
    try {
      rawEntries = readdirSync(real, { withFileTypes: true })
    } catch (err: any) {
      return c.json(
        { error: `Cannot read directory: ${err?.message ?? String(err)}`, code: 'not_found' },
        400,
      )
    }

    const truncated = rawEntries.length > MAX_ENTRIES
    const limited = truncated ? rawEntries.slice(0, MAX_ENTRIES) : rawEntries

    type Entry = { name: string; isDirectory: boolean; isSymlink: boolean; hidden: boolean }
    const entries: Entry[] = []
    for (const dirent of limited) {
      const name = dirent.name
      const isSymlink = dirent.isSymbolicLink()
      let isDirectory = dirent.isDirectory()
      // Symlinks need a follow-up stat to know if they point at a dir.
      // We do that lazily and tolerate failure (dangling symlink, EACCES
      // on the target, …) by leaving `isDirectory` false.
      if (isSymlink) {
        try {
          isDirectory = statSync(join(real, name)).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      if (!includeFiles && !isDirectory) continue
      entries.push({
        name,
        isDirectory,
        isSymlink,
        hidden: name.startsWith('.'),
      })
    }

    // Directories first, then case-insensitive name. Matches the order
    // every OS file picker uses, so muscle memory carries over.
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    return c.json({
      path: real,
      parent,
      home,
      entries,
      truncated,
    })
  })

  /**
   * POST /from-folders
   *
   * Create a new external project from a set of host folders. Returns
   * `409 needsGitRootChoice` when the primary folder is inside a git
   * repo and the user hasn't decided yet (mirrors aider's "walk up to
   * git root" prompt).
   */
  router.post('/from-folders', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) return c.json({ error: 'unauthenticated' }, 401)

    let body: CreateFromFoldersBody
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }

    const rawPaths = Array.isArray(body.paths) ? body.paths : []
    if (rawPaths.length === 0) {
      return c.json({ error: 'paths_required' }, 400)
    }

    // Validate every path before we touch anything.
    const validated: string[] = []
    for (const raw of rawPaths) {
      const result = validatePath(raw)
      if (!result.ok || !result.path) {
        return c.json({ error: result.error, code: result.code }, 400)
      }
      validated.push(result.path)
    }

    const primary = validated[0]!

    // Git-root walk-up. We ask once; the UI either re-submits with the
    // repo root or sets `acceptedGitRoot: false` to keep the subfolder.
    if (body.acceptedGitRoot !== false) {
      const gitRoot = findGitRoot(primary)
      if (gitRoot && gitRoot !== primary && !body.acceptedGitRoot) {
        return c.json(
          {
            needsGitRootChoice: true,
            gitRoot,
            picked: primary,
          },
          409,
        )
      }
      // If acceptedGitRoot=true, swap the primary for the repo root.
      if (gitRoot && body.acceptedGitRoot === true) {
        validated[0] = gitRoot
      }
    }

    const finalPrimary = validated[0]!

    // Identity check. If the folder already has a project.json, rebind
    // to the existing row rather than creating a duplicate. When the
    // recorded projectId is missing from the local DB the binding is
    // stale — almost always because the user deleted the project from
    // the dashboard, which removes the row but leaves the folder's
    // `.shogo/project.json` untouched. Falling through to the fresh-
    // create path below lets `writeProjectJson` overwrite the stale id
    // with a new one, so re-opening a previously-deleted folder Just
    // Works instead of silently 409'ing (the desktop hook surfaces 409s
    // via `Alert.alert`, which is effectively invisible on web/Electron
    // — the user sees "nothing happens"). The "folder bound on another
    // machine" scenario isn't distinguishable from "deleted locally"
    // without a hostname marker, and the practical recovery is the
    // same: rebind to a fresh project on this install.
    const existing = readProjectJson(finalPrimary)
    const existingProject = existing
      ? await prisma.project.findUnique({
          where: { id: existing.projectId },
          include: { projectFolders: true },
        })
      : null
    if (existing && !existingProject) {
      console.log(
        `[local-projects] Stale project.json at ${finalPrimary} ` +
          `(projectId=${existing.projectId} not found in DB). ` +
          `Rebinding folder to a fresh project.`,
      )
    }
    if (existing && existingProject) {
      // Rebind: refresh lastOpenedAt on the primary folder, sync linked
      // folders with the new selection, and backfill chat-only IDE
      // defaults for any project that was created before they were the
      // default (so reopening an older folder project doesn't surface a
      // "Connection timed out" canvas / drag along a stale tech stack).
      const existingSettings: Record<string, unknown> = (() => {
        const raw = existingProject.settings as any
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw }
        if (typeof raw === 'string') {
          try { return JSON.parse(raw) } catch { return {} }
        }
        return {}
      })()
      const mergedSettings = {
        ...existingSettings,
        workingMode: 'external',
        canvasEnabled: false,
        activeMode: 'none',
      }
      // Drop any auto-seeded tech stack so the agent doesn't try to
      // overlay a template into the user's real working tree.
      delete (mergedSettings as any).techStackId
      await prisma.$transaction(async (tx) => {
        await tx.projectFolder.updateMany({
          where: { projectId: existingProject.id, path: finalPrimary },
          data: { lastOpenedAt: new Date(), isPrimary: true },
        })
        for (const otherPath of validated.slice(1)) {
          const existsRow = existingProject.projectFolders.find((f) => f.path === otherPath)
          if (!existsRow) {
            await tx.projectFolder.create({
              data: { projectId: existingProject.id, path: otherPath, isPrimary: false },
            })
          }
        }
        await tx.project.update({
          where: { id: existingProject.id },
          data: { settings: jsonField(mergedSettings) },
        })
      })
      const reloaded = await prisma.project.findUnique({
        where: { id: existingProject.id },
        include: { projectFolders: true },
      })
      prewarmRuntimeBackground(existingProject.id, 'rebind')
      return c.json({ project: reloaded, rebound: true })
    }

    // Workspace resolution: caller-supplied (multi-workspace UI) or the
    // current user's personal workspace (single-tenant local mode).
    let workspaceId = body.workspaceId
    if (!workspaceId) {
      const personal = await prisma.workspace.findFirst({
        where: { members: { some: { userId } } },
        orderBy: { createdAt: 'asc' },
      })
      if (!personal) {
        return c.json({ error: 'no_workspace_for_user' }, 400)
      }
      workspaceId = personal.id
    }

    const name = (body.name && body.name.trim()) || folderDisplayName(finalPrimary)

    // Create the row + folder records + bootstrap `.shogo/` and
    // `.gitignore` atomically. If `writeProjectJson` throws (eg.
    // permission denied), we roll back so we don't leave an orphan row.
    let project
    try {
      project = await prisma.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            name,
            workspaceId: workspaceId!,
            createdBy: userId,
            workingMode: 'external',
            runtimeEnabled: false,
            // Restricted by default; UI prompts user to trust. Mirrors
            // VS Code's Workspace Trust startup behaviour.
            trustLevel: 'restricted',
            // Status `active` so the project appears in the dashboard
            // immediately — `draft` is for the AI builder flow where the
            // user hasn't typed a prompt yet.
            status: 'active',
            tier: 'starter',
            accessLevel: 'private',
            // External (folder-linked) projects open as a chat-only IDE:
            //   - canvasEnabled=false: the canvas/preview panel is hidden so
            //     we don't poll a non-existent Vite/Metro preview (which
            //     otherwise surfaces as "Connection timed out" because
            //     runtimeEnabled=false skips the dev server).
            //   - activeMode='none': no canvas/app mode is active by
            //     default; the user can opt into a tech stack later.
            //   - techStackId intentionally omitted: external repos already
            //     have their own toolchain. We must not auto-pick a stack
            //     and seed `package.json` / config files into the user's
            //     working tree.
            settings: jsonField({
              workingMode: 'external',
              canvasEnabled: false,
              activeMode: 'none',
            }),
          },
        })
        // Insert linked folders. First wins primary.
        await tx.projectFolder.create({
          data: {
            projectId: created.id,
            path: finalPrimary,
            isPrimary: true,
            lastOpenedAt: new Date(),
          },
        })
        for (const otherPath of validated.slice(1)) {
          if (otherPath === finalPrimary) continue
          await tx.projectFolder.create({
            data: { projectId: created.id, path: otherPath, isPrimary: false },
          })
        }
        return created
      })
    } catch (err: any) {
      console.error('[local-projects] Failed to create project row:', err)
      return c.json({ error: 'create_failed', message: err.message }, 500)
    }

    try {
      writeProjectJson(finalPrimary, project.id)
      ensureGitignoreEntry(finalPrimary)
    } catch (err: any) {
      // Filesystem write failed. The DB rows already committed; surface
      // the error but leave the rows so the user can retry without
      // losing the binding. The agent-runtime's own bootstrap will
      // re-attempt `writeProjectJson` on first start.
      console.error(`[local-projects] Bootstrap write failed for ${finalPrimary}:`, err)
      return c.json(
        {
          project,
          warning: 'bootstrap_partial',
          message: `Project created but ${finalPrimary}/.shogo/ could not be written: ${err.message}`,
        },
        201,
      )
    }

    const reloaded = await prisma.project.findUnique({
      where: { id: project.id },
      include: { projectFolders: true },
    })
    prewarmRuntimeBackground(project.id, 'new-project')
    return c.json({ project: reloaded, rebound: false }, 201)
  })

  /**
   * POST /:id/folders { path } — add a linked folder.
   */
  router.post('/:id/folders', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)
    const projectId = c.req.param('id')

    let body: { path?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    const validated = validatePath(body.path ?? '')
    if (!validated.ok || !validated.path) {
      return c.json({ error: validated.error, code: validated.code }, 400)
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { projectFolders: true },
    })
    if (!project) return c.json({ error: 'not_found' }, 404)
    if (project.workingMode !== 'external') {
      return c.json({ error: 'not_external_project' }, 409)
    }
    if (project.projectFolders.some((f) => f.path === validated.path)) {
      return c.json({ error: 'folder_already_linked' }, 409)
    }

    const folder = await prisma.projectFolder.create({
      data: {
        projectId,
        path: validated.path!,
        isPrimary: project.projectFolders.length === 0,
      },
    })
    return c.json({ folder }, 201)
  })

  /**
   * DELETE /:id/folders/:folderId — unlink a folder. Refuses to remove
   * the primary (use POST /:id/primary first).
   */
  router.delete('/:id/folders/:folderId', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)

    const projectId = c.req.param('id')
    const folderId = c.req.param('folderId')

    const folder = await prisma.projectFolder.findUnique({ where: { id: folderId } })
    if (!folder || folder.projectId !== projectId) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (folder.isPrimary) {
      return c.json(
        {
          error: 'cannot_remove_primary',
          message:
            'Primary folders cannot be removed directly. Promote another folder to primary first, then retry.',
        },
        409,
      )
    }
    await prisma.projectFolder.delete({ where: { id: folderId } })
    return c.json({ ok: true })
  })

  /**
   * POST /:id/primary { folderId } — promote a folder to primary. This
   * moves `<old primary>/.shogo/` to `<new primary>/.shogo/` and
   * rewrites `project.json` so identity follows the metadata dir.
   */
  router.post('/:id/primary', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)

    const projectId = c.req.param('id')
    let body: { folderId?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    const folderId = body.folderId
    if (!folderId) return c.json({ error: 'folderId_required' }, 400)

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { projectFolders: true },
    })
    if (!project) return c.json({ error: 'not_found' }, 404)
    if (project.workingMode !== 'external') {
      return c.json({ error: 'not_external_project' }, 409)
    }
    const newPrimary = project.projectFolders.find((f) => f.id === folderId)
    if (!newPrimary) return c.json({ error: 'folder_not_in_project' }, 404)
    const oldPrimary = project.projectFolders.find((f) => f.isPrimary)
    if (oldPrimary && oldPrimary.id === folderId) {
      return c.json({ ok: true, project }, 200)
    }

    // Move `.shogo/` from old to new primary. Use renameSync (atomic,
    // same-filesystem) first, fall back to copy + remove on EXDEV
    // (cross-device move — common when the user picks folders on
    // separate physical disks).
    if (oldPrimary) {
      const fromDir = join(oldPrimary.path, SHOGO_DIR)
      const toDir = join(newPrimary.path, SHOGO_DIR)
      if (existsSync(fromDir)) {
        try {
          if (!existsSync(dirname(toDir))) mkdirSync(dirname(toDir), { recursive: true })
          renameSync(fromDir, toDir)
        } catch (err: any) {
          // EXDEV: cross-device link not permitted. Cross-fs move needs
          // copy + remove.
          if (err?.code === 'EXDEV') {
            cpSync(fromDir, toDir, { recursive: true })
            rmSync(fromDir, { recursive: true, force: true })
          } else {
            console.error(`[local-projects] Could not move ${fromDir} -> ${toDir}:`, err)
            return c.json(
              { error: 'shogo_dir_move_failed', message: err.message },
              500,
            )
          }
        }
      }
    }

    // Rewrite project.json so the identity file still names this projectId.
    writeProjectJson(newPrimary.path, project.id)
    ensureGitignoreEntry(newPrimary.path)

    await prisma.$transaction(async (tx) => {
      await tx.projectFolder.updateMany({
        where: { projectId, isPrimary: true },
        data: { isPrimary: false },
      })
      await tx.projectFolder.update({
        where: { id: folderId },
        data: { isPrimary: true, lastOpenedAt: new Date() },
      })
    })

    const reloaded = await prisma.project.findUnique({
      where: { id: projectId },
      include: { projectFolders: true },
    })
    return c.json({ project: reloaded })
  })

  /**
   * POST /:id/trust { trusted: boolean } — flip the project's
   * `trustLevel`. The agent-runtime reads this on every chat turn
   * (via the same /project info path it uses for templateId), so
   * write/exec tools narrow/widen in-flight.
   */
  router.post('/:id/trust', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)
    const projectId = c.req.param('id')
    let body: { trusted?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    if (typeof body.trusted !== 'boolean') {
      return c.json({ error: 'trusted_required' }, 400)
    }
    const project = await prisma.project.update({
      where: { id: projectId },
      data: { trustLevel: body.trusted ? 'trusted' : 'restricted' },
      include: { projectFolders: true },
    })
    return c.json({ project })
  })

  /**
   * GET /recent — recent external projects for the "Open Recent" UI.
   * Sorted by the max `lastOpenedAt` across linked folders, falling
   * back to project creation time.
   */
  router.get('/recent', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)

    const projects = await prisma.project.findMany({
      where: {
        workingMode: 'external',
        workspace: { members: { some: { userId: auth.userId } } },
      },
      include: { projectFolders: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    })
    // Re-rank by max(lastOpenedAt). Cheaper to do in JS than a window
    // function — caller asked for at most 50.
    const ranked = projects
      .map((p) => {
        const latest = p.projectFolders.reduce<number>((acc, f) => {
          const t = f.lastOpenedAt ? new Date(f.lastOpenedAt).getTime() : 0
          return Math.max(acc, t)
        }, 0)
        return { ...p, _lastOpenedAt: latest || new Date(p.createdAt).getTime() }
      })
      .sort((a, b) => b._lastOpenedAt - a._lastOpenedAt)
    return c.json({ projects: ranked })
  })

  return router
}

// =============================================================================
// Helpers
// =============================================================================

function folderDisplayName(p: string): string {
  const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
  return base || 'New Project'
}

// Wrap `settings` JSON for both pg (Json) and sqlite (String).
// At runtime the prisma client's adapter accepts strings transparently
// because `Json` ultimately marshals through `JSON.stringify` on the
// boundary. We could special-case via `process.env.DATABASE_URL.startsWith('file:')`
// but the simpler test is "does this client have JsonValue?". A bare
// object is the safe fallback.
function jsonField(value: Record<string, unknown>): any {
  if (process.env.DATABASE_URL?.startsWith('file:')) {
    return JSON.stringify(value)
  }
  return value
}
