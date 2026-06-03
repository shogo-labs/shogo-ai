// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace-runtime boot mode helpers.
 *
 * A WORKSPACE runtime serves a merged tree of several attached projects:
 * `WORKSPACE_DIR` points at a per-workspace merged root that contains only
 * this workspace's attached projects as top-level subfolders (on host they
 * are symlinks into the shared `workspaces/` pool; in cloud they are real
 * subfolders on the pod volume). This differs from the single-project
 * `managed` boot in two ways the boot path must respect:
 *
 *   1. Template / tech-stack seeding must be skipped — the parent dir
 *      already contains real project subfolders; dumping a Vite + React
 *      scaffold (or running the legacy APP-layout migration) at the
 *      parent root would corrupt them. This mirrors the `external`
 *      (VS Code folder) guard.
 *   2. The `basename(WORKSPACE_DIR) === PROJECT_ID` sanity check does
 *      not apply — a workspace runtime has a `WORKSPACE_ID`, not a single
 *      `PROJECT_ID`, and `WORKSPACE_DIR` ends in the workspaces parent
 *      name, not a project id.
 *
 * Path allowance needs no special handling: every attached project is a
 * descendant of `WORKSPACE_DIR`, and `getAllowedRoots()` already admits
 * descendants of the workspace dir.
 *
 * These are pure functions so the boot decisions can be unit-tested
 * without importing the side-effectful `server.ts` boot path.
 */

export type WorkingMode = 'managed' | 'external'

/** True when the runtime was booted as a multi-project workspace runtime. */
export function isWorkspaceRuntimeMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKSPACE_RUNTIME === 'true'
}

/** The workspace id this runtime serves, if any (workspace mode only). */
export function workspaceRuntimeId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isWorkspaceRuntimeMode(env)) return null
  return env.WORKSPACE_ID || null
}

/**
 * Attached project ids for a workspace runtime, parsed from the
 * comma-separated `WORKSPACE_PROJECT_IDS` env (set by build-workspace-env.ts).
 * Returns [] for non-workspace runtimes or when unset.
 */
export function workspaceAttachedProjectIds(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isWorkspaceRuntimeMode(env)) return []
  const raw = env.WORKSPACE_PROJECT_IDS
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export interface WorkspaceProjectEntry {
  id: string
  name: string
}

/**
 * Parse the project catalog the API attaches as `WORKSPACE_PROJECTS`
 * (JSON array of `{ id, name }`, set by build-workspace-env.ts). Returns
 * [] for non-workspace runtimes, unset/empty env, or malformed JSON.
 * Each entry is sanitised: only string id/name survive, name defaults to
 * the id.
 */
export function workspaceProjectsManifest(env: NodeJS.ProcessEnv = process.env): WorkspaceProjectEntry[] {
  if (!isWorkspaceRuntimeMode(env)) return []
  const raw = env.WORKSPACE_PROJECTS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: WorkspaceProjectEntry[] = []
    for (const e of parsed) {
      if (!e || typeof e !== 'object') continue
      const id = typeof (e as any).id === 'string' ? (e as any).id : null
      if (!id) continue
      const name = typeof (e as any).name === 'string' && (e as any).name.length > 0 ? (e as any).name : id
      out.push({ id, name })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Render the human-readable `WORKSPACE.md` that sits at the merged-tree
 * root so the agent immediately understands which subfolder is which
 * project. Kept as a pure function for snapshot-style unit testing.
 */
export function renderWorkspaceManifestMarkdown(
  workspaceId: string,
  projects: WorkspaceProjectEntry[],
): string {
  const lines: string[] = [
    '# Workspace',
    '',
    `This is a **multi-project workspace** runtime (workspace \`${workspaceId}\`).`,
    'Each top-level UUID-named folder below is a separate project you can',
    'read and edit. Treat them as sibling repos under one root.',
    '',
    '## Attached projects',
    '',
  ]
  if (projects.length === 0) {
    lines.push('_No projects attached._')
  } else {
    for (const p of projects) {
      lines.push(`- \`${p.id}/\` — **${p.name}**`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Path prefix under which a workspace runtime serves each attached
 * project's preview. The single runtime HTTP port multiplexes every
 * attached project by path:
 *
 *   /p/<projectId>/                 → that project's `dist/index.html`
 *   /p/<projectId>/assets/foo.js    → static asset from its `dist/`
 *   /p/<projectId>/api/*            → its `server.tsx` sidecar
 *   /p/<projectId>/preview/status   → its PreviewManager control routes
 *
 * (Single-project runtimes keep serving everything at `/` — these routes
 * are only registered in workspace mode.)
 */
export const WORKSPACE_PREVIEW_PREFIX = '/p/'

/** A project id is a safe single path segment: no slashes, no traversal. */
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export interface ParsedWorkspacePreviewPath {
  /** The attached project id from the path. */
  projectId: string
  /**
   * The remainder of the path *after* `/p/<projectId>`, always starting
   * with `/`. `/p/abc` and `/p/abc/` both yield `rest === '/'`.
   */
  rest: string
}

/**
 * Parse a request pathname of the form `/p/<projectId>[/<rest>]`.
 *
 * Returns `null` when the path is not a workspace-preview path or the
 * project-id segment fails the safe-segment check (which also rejects
 * `..` traversal and empty ids). Pure — safe to unit test.
 */
export function parseWorkspacePreviewPath(pathname: string): ParsedWorkspacePreviewPath | null {
  if (!pathname.startsWith(WORKSPACE_PREVIEW_PREFIX)) return null
  const after = pathname.slice(WORKSPACE_PREVIEW_PREFIX.length)
  if (after.length === 0) return null
  const slash = after.indexOf('/')
  const projectId = slash === -1 ? after : after.slice(0, slash)
  if (!SAFE_PROJECT_ID.test(projectId)) return null
  const rest = slash === -1 ? '/' : after.slice(slash) || '/'
  return { projectId, rest: rest.length === 0 ? '/' : rest }
}

/** Build the runtime-relative preview path for a project (inverse of parse). */
export function buildWorkspacePreviewPath(projectId: string, rest = '/'): string {
  const tail = rest.startsWith('/') ? rest : `/${rest}`
  return `${WORKSPACE_PREVIEW_PREFIX}${projectId}${tail === '/' ? '/' : tail}`
}

/** Membership check: is `projectId` one of the runtime's attached projects? */
export function isAttachedProjectId(projectId: string, attachedIds: string[]): boolean {
  return attachedIds.includes(projectId)
}

/**
 * Parse the optional per-project external preview URL map the API may
 * attach as `WORKSPACE_PREVIEW_URLS` (JSON object `{ [projectId]: url }`).
 * Used in cloud/k8s where each project has its own externally-reachable
 * URL; unset locally (callers fall back to the path-prefixed localhost
 * URL). Returns {} for non-workspace runtimes, unset/empty, or malformed.
 */
export function parseWorkspacePreviewUrls(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!isWorkspaceRuntimeMode(env)) return {}
  const raw = env.WORKSPACE_PREVIEW_URLS
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Whether the boot should skip managed template/tech-stack seeding and
 * the legacy APP-layout migration. True for external folder projects AND
 * workspace runtimes.
 */
export function shouldSkipManagedSeeding(opts: {
  workingMode: WorkingMode
  isWorkspaceRuntime: boolean
}): boolean {
  return opts.workingMode === 'external' || opts.isWorkspaceRuntime
}

/**
 * Whether the `basename(WORKSPACE_DIR) === PROJECT_ID` sanity check
 * should run. Skipped for external projects (by design) and for
 * workspace runtimes (no single project id).
 */
export function shouldEnforceProjectIdSanity(opts: {
  workingMode: WorkingMode
  isWorkspaceRuntime: boolean
}): boolean {
  return opts.workingMode !== 'external' && !opts.isWorkspaceRuntime
}
