// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Environment builder for a WORKSPACE runtime assignment.
 *
 * The workspace-scoped sibling of `build-project-env.ts`. Where
 * `buildProjectEnv` assembles the env for a single-project pod, this
 * assembles the env for a runtime that mounts several attached projects
 * as subfolders under one `WORKSPACE_DIR` (a per-workspace MERGED ROOT
 * built by RuntimeManager.buildWorkspaceMergedRoot — on host that's a
 * dir of symlinks to the real `workspaces/<id>` project dirs; in cloud
 * it's the pod volume that holds only the attached projects). It carries:
 *
 *   - WORKSPACE_ID / WORKSPACE_RUNTIME — mode markers the agent-runtime
 *     boot reads to switch into merged-root mode.
 *   - WORKSPACE_PROJECT_IDS — comma-separated attached project ids, so
 *     the runtime knows which subfolders to mount / sync / preview.
 *   - RUNTIME_AUTH_SECRET — the workspace runtime token (NOT a project
 *     token); the pod uses it for `x-runtime-token` RPC back to the API.
 *   - AI_PROXY_TOKENS — JSON map of projectId -> AI proxy token so the
 *     runtime can attribute each project's model usage correctly. (The
 *     per-project injection at tool-spawn time lands in Phase 2b; for
 *     now the map is the source of truth.)
 *   - AI proxy URLs / S3 config / model overrides — identical to the
 *     project builder so cloud, desktop and host behave the same.
 *
 * Note: on host the merged root holds symlinks, and path allowance
 * (`assertAllowedPath`) realpath-resolves symlinks back to the real
 * `workspaces/<id>` dirs — so RuntimeManager.doStartWorkspace ships those
 * real dirs as `LINKED_FOLDERS` to keep them admitted as allowed roots.
 * That wiring lives in the manager, not here, because only it knows the
 * on-disk layout. In cloud (real subfolders, no symlinks) the descendant
 * rule under `WORKSPACE_DIR` suffices and LINKED_FOLDERS is unset.
 */

import { generateProxyToken } from '../ai-proxy-token'
import { getAgentModeOverrides } from '@shogo/model-catalog'
import { deriveWorkspaceRuntimeToken } from '../workspace-runtime-token'

export interface BuildWorkspaceEnvOpts {
  logPrefix?: string
  /**
   * For project-anchored merged runtimes: the anchor project id. Exposed to
   * the runtime as `WORKSPACE_ANCHOR_PROJECT_ID` so it can pick a sensible
   * default preview target (`/p/<anchor>`) and label the merged root. Unset
   * for workspace-session runtimes (no single anchor).
   */
  anchorProjectId?: string
  /**
   * Test-only injection seams. Production callers omit these and the
   * builder resolves prisma / owner lookup / token mint lazily, exactly
   * like `buildProjectEnv`.
   */
  _loadWorkspace?: (workspaceId: string) => Promise<{ name?: string | null; composioScope?: string | null } | null>
  _loadProjectWorkspaceIds?: (projectIds: string[]) => Promise<Map<string, string>>
  _getProjectOwnerUserId?: (projectId: string) => Promise<string | undefined>
  _generateProxyToken?: typeof generateProxyToken
  _loadProjects?: (projectIds: string[]) => Promise<Array<{ id: string; name: string | null }>>
  /**
   * Cloud per-project DB provisioning. When supplied, called once per
   * attached project to obtain that project's isolated DATABASE_URL (e.g. a
   * CloudNativePG database minted by `database.service.provisionDatabase`).
   * Returning null/undefined for a project leaves it on the runtime's local
   * per-subfolder sqlite default. Omitted entirely in host/desktop mode, so
   * local workspaces keep using one sqlite file per project subfolder with
   * zero provisioning. The resulting map ships as `WORKSPACE_DATABASE_URLS`
   * and is consumed by the agent-runtime's per-project sidecar env
   * (`resolveApiServerEnv`).
   */
  _provisionProjectDatabase?: (
    projectId: string,
    workspaceId: string,
  ) => Promise<string | null | undefined>
}

/**
 * Build the environment for assigning a set of attached projects to a
 * workspace runtime. `attachedProjectIds` must already be validated to
 * belong to `workspaceId` (see workspace-session.service.ts).
 */
export async function buildWorkspaceEnv(
  workspaceId: string,
  attachedProjectIds: string[],
  opts: BuildWorkspaceEnvOpts = {},
): Promise<Record<string, string>> {
  const prefix = opts.logPrefix ?? 'buildWorkspaceEnv'
  const startTime = Date.now()

  if (!workspaceId) {
    throw new Error('[buildWorkspaceEnv] workspaceId is required')
  }

  const env: Record<string, string> = {
    WORKSPACE_ID: workspaceId,
    WORKSPACE_RUNTIME: 'true',
    WORKSPACE_PROJECT_IDS: attachedProjectIds.join(','),
  }
  if (opts.anchorProjectId) {
    env.WORKSPACE_ANCHOR_PROJECT_ID = opts.anchorProjectId
  }

  // Workspace identity carries the base agent persona; per-project
  // AGENTS.md/MEMORY.md layering happens runtime-side (Phase 2b).
  try {
    const loadWorkspace =
      opts._loadWorkspace ??
      (async (id: string) => {
        const { prisma } = await import('../prisma')
        return (await prisma.workspace.findUnique({
          where: { id },
          select: { name: true, composioScope: true } as any,
        })) as { name?: string | null; composioScope?: string | null } | null
      })
    const ws = await loadWorkspace(workspaceId)
    if (ws?.name) env.AGENT_NAME = ws.name
    // Workspace sessions prefer workspace-scoped Composio connections so
    // one OAuth is shared across all attached projects.
    const scope = ws?.composioScope
    env.COMPOSIO_USER_SCOPE = scope === 'project' ? 'project' : 'workspace'
  } catch (err: any) {
    console.error(`[${prefix}] Failed to load workspace ${workspaceId}:`, err?.message)
  }

  // Project catalog so the runtime can map UUID-named subfolders back to
  // human project names. Without this the agent sees the merged tree as
  // a pile of "UUID-named folders" with no idea what each one is. The
  // runtime materialises this as WORKSPACE.md + .shogo/workspace.json on
  // boot (see workspace-runtime-mode.ts / server.ts).
  try {
    const loadProjects =
      opts._loadProjects ??
      (async (ids: string[]) => {
        const { prisma } = await import('../prisma')
        return (await prisma.project.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })) as Array<{ id: string; name: string | null }>
      })
    const rows = attachedProjectIds.length ? await loadProjects(attachedProjectIds) : []
    const nameById = new Map(rows.map((r) => [r.id, r.name]))
    // Preserve attach order; fall back to the id when a name is missing.
    const manifest = attachedProjectIds.map((id) => ({ id, name: nameById.get(id) || id }))
    env.WORKSPACE_PROJECTS = JSON.stringify(manifest)
  } catch (err: any) {
    console.error(`[${prefix}] Failed to build project catalog for workspace ${workspaceId}:`, err?.message)
  }

  // Per-project AI proxy tokens, keyed by projectId, so usage is
  // attributed to the project that actually ran the model.
  const tokenStart = Date.now()
  try {
    const generate = opts._generateProxyToken ?? generateProxyToken
    const getOwner =
      opts._getProjectOwnerUserId ??
      (async (projectId: string) => {
        const { getProjectOwnerUserId } = await import('../project-user-context')
        return getProjectOwnerUserId(projectId)
      })

    const tokens: Record<string, string> = {}
    for (const projectId of attachedProjectIds) {
      const ownerUserId = await getOwner(projectId)
      tokens[projectId] = await generate(projectId, workspaceId, ownerUserId, 7 * 24 * 60 * 60 * 1000)
    }
    env.AI_PROXY_TOKENS = JSON.stringify(tokens)
    // Back-compat default: SDK paths that read a single AI_PROXY_TOKEN
    // get the first attached project's token until Phase 2b threads the
    // per-project token through every tool spawn.
    const first = attachedProjectIds[0]
    if (first && tokens[first]) env.AI_PROXY_TOKEN = tokens[first]
  } catch (err: any) {
    console.error(`[${prefix}] Failed to mint proxy tokens for workspace ${workspaceId}:`, err?.message)
  }
  console.log(`[${prefix}] proxy tokens took ${Date.now() - tokenStart}ms`)

  // Per-project DB isolation. Local/desktop: omit the map → each project's
  // API sidecar pins its own per-subfolder sqlite (resolveApiServerEnv).
  // Cloud: a provisioning seam yields an isolated DATABASE_URL per project,
  // shipped as a JSON map the runtime threads into the matching sidecar.
  if (opts._provisionProjectDatabase) {
    const dbStart = Date.now()
    const dbUrls: Record<string, string> = {}
    for (const projectId of attachedProjectIds) {
      try {
        const url = await opts._provisionProjectDatabase(projectId, workspaceId)
        if (typeof url === 'string' && url.length > 0) dbUrls[projectId] = url
      } catch (err: any) {
        console.error(`[${prefix}] DB provision failed for project ${projectId}:`, err?.message)
      }
    }
    if (Object.keys(dbUrls).length > 0) {
      env.WORKSPACE_DATABASE_URLS = JSON.stringify(dbUrls)
    }
    console.log(`[${prefix}] per-project DB provisioning took ${Date.now() - dbStart}ms`)
  }

  // Workspace-scoped runtime capability (NOT a project token).
  env.RUNTIME_AUTH_SECRET = deriveWorkspaceRuntimeToken(workspaceId)

  // AI proxy URLs — identical resolution to build-project-env.ts.
  const ns = process.env.SYSTEM_NAMESPACE
  let apiBase: string
  if (ns) {
    apiBase = `http://api.${ns}.svc.cluster.local`
  } else {
    const apiPort = process.env.API_PORT || '8002'
    const apiHost = process.env.API_HOST || 'localhost'
    apiBase = `http://${apiHost}:${apiPort}`
  }
  env.AI_PROXY_URL = `${apiBase}/api/ai/v1`
  env.ANTHROPIC_PROXY_URL = `${apiBase}/api/ai/anthropic`
  env.OPENAI_PROXY_URL = `${apiBase}/api/ai/v1`
  env.SHOGO_API_URL = apiBase

  const modelOverrides = getAgentModeOverrides()
  if (modelOverrides.basic) env.AGENT_BASIC_MODEL = modelOverrides.basic
  if (modelOverrides.advanced) env.AGENT_ADVANCED_MODEL = modelOverrides.advanced

  if (process.env.S3_WORKSPACES_BUCKET) {
    env.S3_WORKSPACES_BUCKET = process.env.S3_WORKSPACES_BUCKET
    env.S3_REGION = process.env.S3_REGION || 'us-east-1'
    env.S3_WATCH_ENABLED = 'true'
    env.S3_SYNC_INTERVAL = '30000'
    if (process.env.S3_ENDPOINT) env.S3_ENDPOINT = process.env.S3_ENDPOINT
    if (process.env.S3_FORCE_PATH_STYLE === 'true') env.S3_FORCE_PATH_STYLE = 'true'
  }

  console.log(`[${prefix}] total ${Date.now() - startTime}ms for workspace ${workspaceId} (${attachedProjectIds.length} projects)`)
  return env
}
