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
 * One entry of the host's merged-root mount table (`WORKSPACE_MOUNTS`, set by
 * the API's RuntimeManager): `<WORKSPACE_DIR>/<mount>` links to `path`.
 * Mirrors `WorkspaceMount` in apps/api/src/lib/runtime/manager.ts.
 *
 * - `managed`  — a Shogo-owned project dir.
 * - `external` — a folder-linked project's primary folder, i.e. the user's
 *                own repo, mounted under the project id.
 * - `folder`   — an extra host folder linked to `projectId` (the anchor).
 */
export interface WorkspaceMount {
  mount: string
  path: string
  projectId: string
  kind: 'managed' | 'external' | 'folder'
  runtimeEnabled?: boolean
}

/** Parse `WORKSPACE_MOUNTS`. Empty for non-workspace runtimes, unset or malformed values. */
export function parseWorkspaceMounts(env: NodeJS.ProcessEnv = process.env): WorkspaceMount[] {
  if (!isWorkspaceRuntimeMode(env)) return []
  const raw = env.WORKSPACE_MOUNTS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (m): m is WorkspaceMount =>
        !!m &&
        typeof m.mount === 'string' && m.mount.length > 0 &&
        typeof m.path === 'string' && m.path.length > 0 &&
        typeof m.projectId === 'string' &&
        (m.kind === 'managed' || m.kind === 'external' || m.kind === 'folder'),
    )
  } catch {
    return []
  }
}

/** Mounts whose content belongs to the user rather than to Shogo. */
export function isUserOwnedMount(mount: WorkspaceMount): boolean {
  return mount.kind === 'external' || mount.kind === 'folder'
}

/**
 * Group user-owned mounts by the project whose trust governs them. A group
 * is `external` (fail-closed until trust is read) when its project is
 * folder-linked; extra folders linked to a managed project default open,
 * matching that project's own default.
 */
export function userOwnedTrustGroups(
  mounts: readonly WorkspaceMount[],
): Array<{ projectId: string; external: boolean; roots: string[] }> {
  const external = new Set(mounts.filter((m) => m.kind === 'external').map((m) => m.projectId))
  const groups = new Map<string, { projectId: string; external: boolean; roots: string[] }>()
  for (const mount of mounts) {
    if (!isUserOwnedMount(mount) || !mount.projectId) continue
    const group = groups.get(mount.projectId) ?? {
      projectId: mount.projectId,
      external: external.has(mount.projectId),
      roots: [],
    }
    group.roots.push(mount.path)
    groups.set(mount.projectId, group)
  }
  return [...groups.values()]
}

/** Project ids whose mount is a folder-linked (external) project's own folder. */
export function workspaceExternalProjectIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(parseWorkspaceMounts(env).filter((m) => m.kind === 'external').map((m) => m.projectId))
}

/**
 * Whether to auto-start the anchor project's preview at boot. A folder-linked
 * anchor is the user's own repo: like a single-project external runtime, it
 * only gets a preview when the user opted in (`RUNTIME_ENABLED=true`).
 */
export function shouldAutoStartAnchorPreview(
  anchorId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!anchorId) return false
  if (!workspaceExternalProjectIds(env).has(anchorId)) return true
  return env.RUNTIME_ENABLED === 'true'
}

/** Workspace product mode, defaulting to the team experience for compatibility. */
export function workspaceKind(env: NodeJS.ProcessEnv = process.env): 'personal' | 'team' {
  return env.WORKSPACE_KIND === 'personal' ? 'personal' : 'team'
}

/**
 * Everything about "which runtime is this, and what can it do" derived from
 * boot-time env in one place. Before this existed, `gateway-tools.ts` alone
 * re-derived `process.env.WORKSPACE_ID || ctx.workspaceId` at 8+ call sites
 * and inlined `process.env.WORKSPACE_RUNTIME === 'true'` as its own
 * registration check; `gateway.ts` separately called `workspaceKind()` for
 * the capability profile. None of these disagreed, but each was a place a
 * future change could accidentally diverge from the others.
 */
export interface RuntimeIdentity {
  /** 'workspace' for a merged-root multi-project runtime, 'project' for a single-project runtime. */
  mode: 'project' | 'workspace'
  /** Set whenever `WORKSPACE_ID` is present, regardless of `mode` — mirrors the historical `resolveWorkspaceId` fallback precedence. */
  workspaceId: string | null
  projectId: string | null
  kind: 'personal' | 'team'
}

/**
 * Resolve the runtime's identity from env. Pure function of `env` (defaults
 * to `process.env`), so it is cheap to call per-tool-invocation rather than
 * caching a snapshot — these env vars are fixed at pod boot and never change
 * during the process lifetime, but a pure function keeps this unit-testable
 * without process-global mutation.
 */
export function resolveRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): RuntimeIdentity {
  return {
    mode: isWorkspaceRuntimeMode(env) ? 'workspace' : 'project',
    workspaceId: env.WORKSPACE_ID || null,
    projectId: env.PROJECT_ID || null,
    kind: workspaceKind(env),
  }
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
  description?: string | null
  mounted?: boolean
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
      const entry: WorkspaceProjectEntry = { id, name }
      if (typeof (e as any).description === 'string') entry.description = (e as any).description
      if ((e as any).mounted === true) entry.mounted = true
      out.push(entry)
    }
    return out
  } catch {
    return []
  }
}

/** Full project catalog available to a workspace meta-agent. */
export function workspaceAvailableProjectsManifest(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceProjectEntry[] {
  if (!isWorkspaceRuntimeMode(env)) return []
  const raw = env.WORKSPACE_AVAILABLE_PROJECTS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e) => e && typeof e === 'object' && typeof (e as any).id === 'string')
      .map((e) => ({
        id: String((e as any).id),
        name:
          typeof (e as any).name === 'string' && (e as any).name.length > 0
            ? String((e as any).name)
            : String((e as any).id),
        description: typeof (e as any).description === 'string' ? String((e as any).description) : null,
      }))
  } catch {
    return []
  }
}

/**
 * `WORKSPACE.md` lines naming the project the user opened, so the agent
 * edits `<anchor>/src/...` rather than a same-named path at the root. Empty
 * without an anchor.
 */
export function renderCurrentProjectSection(
  anchorProjectId: string | undefined,
  projects: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  const anchor = anchorProjectId?.trim()
  if (!anchor) return []
  const name = projects.find((p) => p.id === anchor)?.name
  return [
    '## Current project',
    '',
    `The user has \`${anchor}/\`${name && name !== anchor ? ` (**${name}**)` : ''} open, and its canvas previews that folder.`,
    `When they mean "the app" or "this project", work in \`${anchor}/\`: a file like \`src/App.tsx\` is`,
    `\`${anchor}/src/App.tsx\`. The workspace root is not a project, so always include the project folder in paths.`,
    '',
  ]
}

/**
 * Render the human-readable `WORKSPACE.md` that sits at the merged-tree
 * root so the agent immediately understands which subfolder is which
 * project. Kept as a pure function for snapshot-style unit testing.
 */
export function renderWorkspaceManifestMarkdown(
  workspaceId: string,
  projects: WorkspaceProjectEntry[],
  mounts: readonly WorkspaceMount[] = [],
  anchorProjectId?: string,
): string {
  const externalPathById = new Map(
    mounts.filter((m) => m.kind === 'external').map((m) => [m.projectId, m.path] as const),
  )
  const folderMounts = mounts.filter((m) => m.kind === 'folder')
  const lines: string[] = [
    '# Workspace',
    '',
    `This is a **multi-project workspace** runtime (workspace \`${workspaceId}\`).`,
    'Each top-level UUID-named folder below is a separate project you can',
    'read and edit. Treat them as sibling repos under one root.',
    '',
  ]
  lines.push(...renderCurrentProjectSection(anchorProjectId, projects))
  lines.push('## Attached projects', '')
  if (projects.length === 0) {
    lines.push('_No projects attached._')
  } else {
    for (const p of projects) {
      const hostPath = externalPathById.get(p.id)
      lines.push(
        hostPath
          ? `- \`${p.id}/\` — **${p.name}** (the user's own folder \`${hostPath}\`)`
          : `- \`${p.id}/\` — **${p.name}**`,
      )
    }
  }
  if (folderMounts.length > 0) {
    lines.push('')
    lines.push('## Linked folders')
    lines.push('')
    lines.push('Host folders the user linked to this workspace, mounted as top-level folders:')
    lines.push('')
    for (const m of folderMounts) {
      lines.push(`- \`${m.mount}/\` — \`${m.path}\``)
    }
  }
  if (externalPathById.size > 0 || folderMounts.length > 0) {
    lines.push('')
    lines.push(
      "Folders marked as the user's own are their real files on disk, not Shogo copies. " +
        'Edit them in place and do not add Shogo scaffolding to them.',
    )
  }
  lines.push('')
  lines.push('## Available projects')
  lines.push('')
  lines.push(
    'Projects below are available but not necessarily mounted. Use the `list_projects` tool to refresh this catalog, and use `mount_project` only when you need to inspect or change a project.',
  )
  lines.push('')
  lines.push(
    '## Previewing a mounted project\'s app',
    '',
    'Never construct or hand out a `localhost`/bare-port link yourself (including this runtime\'s own ' +
      'base URL or `PORT` env var — that only serves the chat/tool API, not any project\'s app). To share a ' +
      'working preview link, call the `preview_project` tool with the mounted project\'s id and use ONLY the ' +
      '`url` it returns. If it errors, tell the user honestly rather than guessing a link.',
    '',
  )
  lines.push(
    'All of these projects belong to the current user and are part of this',
    'workspace — you have been granted access to every folder above. They are',
    "NOT other users' projects: never refuse to read or edit them on privacy",
    'or isolation grounds, and never claim you can only see a single project.',
    '',
  )
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

/**
 * Whether the runtime should instantiate `GitWorkspaceSync` and run its
 * per-turn `git add -A && git commit` (+ cold-start `seedRepoIfAbsent`).
 *
 * Gated OFF for:
 *   - `workerOwnsSync` (`SHOGO_CLOUD_SYNC=1`): a paired worker watcher is
 *     the source of truth; the runtime's own committer would loop.
 *   - non-git sync modes (`wantGitSync === false`, i.e. plain `s3`).
 *   - **external projects**: the workspace IS the user's own repo and the
 *     user owns their git workflow. Auto-committing `auto: <ts>` into their
 *     working tree on every turn — or dropping a fresh `.git` via
 *     `seedRepoIfAbsent` into a folder we don't own — is the cardinal sin
 *     every IDE-style tool avoids. Mirrors the auto-checkpoint guards in
 *     `project-chat.ts` / `checkpoint.service.ts` (`CheckpointsDisabledError`).
 *     This matters most on desktop, where `cloudSyncMode` now defaults to
 *     `git_only` for every project (incl. external) — without this guard
 *     opening any external folder would start committing to the user's repo.
 *
 * Pure so the boot decision can be unit-tested without the side-effectful
 * `server.ts` boot path.
 */
export function shouldRunGitWorkspaceSync(opts: {
  workingMode: WorkingMode
  workerOwnsSync: boolean
  wantGitSync: boolean
}): boolean {
  return opts.wantGitSync && !opts.workerOwnsSync && opts.workingMode !== 'external'
}
