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
 *   - WORKSPACE_ID / WORKSPACE_RUNTIME / WORKSPACE_KIND — mode markers the agent-runtime
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
import { resolveAgentModelEnv } from './agent-model-defaults'
import { deriveWorkspaceRuntimeToken } from '../workspace-runtime-token'
import { buildToolsProxyUrl } from '../cloud-urls'
import { getSandboxExecOverride } from '../sandbox-exec-setting'
import { parseProjectSettings } from '../project-settings'

export interface BuildWorkspaceEnvOpts {
  logPrefix?: string
  /**
   * Metal microVM assignment. When true the AI/tools proxy + API URLs are
   * pinned to the PUBLIC API base (SHOGO_PUBLIC_API_URL/APP_URL) instead of the
   * in-cluster service DNS, which is unresolvable from a Firecracker guest that
   * runs outside the OKE cluster. Mirrors `buildProjectEnv({ forMetal })`.
   */
  forMetal?: boolean
  /**
   * For project-anchored merged runtimes: the anchor project id. Exposed to
   * the runtime as `WORKSPACE_ANCHOR_PROJECT_ID` so it can pick a sensible
   * default preview target (`/p/<anchor>`) and label the merged root. Unset
   * for workspace-session runtimes (no single anchor).
   */
  anchorProjectId?: string
  /**
   * Subset of attached projects to mount read-only. Exposed to the runtime as
   * `WORKSPACE_READONLY_PROJECT_IDS` so the cloud pod can mark those members'
   * subfolders write-denied (the host computes READONLY_ROOTS from real dirs
   * in the manager; cloud derives them from this list relative to its own
   * WORKSPACE_DIR). Unset → all members writable.
   */
  readonlyProjectIds?: string[]
  /**
   * Test-only injection seams. Production callers omit these and the
   * builder resolves prisma / owner lookup / token mint lazily, exactly
   * like `buildProjectEnv`.
   */
  _loadWorkspace?: (workspaceId: string) => Promise<{
    name?: string | null
    kind?: string | null
    profileName?: string | null
    agentProfile?: { name?: string | null } | null
    composioScope?: string | null
  } | null>
  _loadProjectWorkspaceIds?: (projectIds: string[]) => Promise<Map<string, string>>
  _getProjectOwnerUserId?: (projectId: string) => Promise<string | undefined>
  _generateProxyToken?: typeof generateProxyToken
  _loadProjects?: (
    projectIds: string[],
  ) => Promise<Array<{ id: string; name: string | null; settings?: unknown }>>
  _loadAvailableProjects?: (
    workspaceId: string,
  ) => Promise<Array<{ id: string; name: string | null; description?: string | null }>>
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
  /**
   * Test-only injection seam for the workspace-level fallback proxy token
   * (see the AI_PROXY_TOKEN block below). Production callers omit this and
   * the builder resolves the workspace owner via a DB lookup.
   */
  _getWorkspaceOwnerUserId?: (workspaceId: string) => Promise<string | undefined>
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
  if (opts.readonlyProjectIds && opts.readonlyProjectIds.length > 0) {
    env.WORKSPACE_READONLY_PROJECT_IDS = opts.readonlyProjectIds.join(',')
  }
  // Metal guests hold no S3 credentials: the host hydrates each member folder
  // after assign and exports it on evict. Mirrors buildProjectEnv({ forMetal }).
  if (opts.forMetal) {
    env.SHOGO_DURABILITY_HOST_MEDIATED = '1'
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
          select: {
            name: true,
            kind: true,
            composioScope: true,
            agentProfile: { select: { name: true } },
          } as any,
        })) as {
          name?: string | null
          kind?: string | null
          composioScope?: string | null
          agentProfile?: { name?: string | null } | null
        } | null
      })
    const ws = await loadWorkspace(workspaceId)
    const { normalizeWorkspaceKind } = await import('../../services/workspace.service')
    env.WORKSPACE_KIND = normalizeWorkspaceKind(ws?.kind)
    const profileName = ws?.profileName || ws?.agentProfile?.name
    if (profileName || ws?.name) env.AGENT_NAME = profileName || ws.name!
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
          select: { id: true, name: true, settings: true },
        })) as Array<{ id: string; name: string | null; settings?: unknown }>
      })
    const rows = attachedProjectIds.length ? await loadProjects(attachedProjectIds) : []
    const nameById = new Map(rows.map((r) => [r.id, r.name]))
    // Preserve attach order; fall back to the id when a name is missing.
    const manifest = attachedProjectIds.map((id) => ({ id, name: nameById.get(id) || id }))
    env.WORKSPACE_PROJECTS = JSON.stringify(manifest)

    // Per-member tech stack, so the runtime can seed a brand-new member with
    // the right starter. Not TECH_STACK_ID: that would seed one stack into the
    // merged root, which holds sibling project folders rather than one app.
    const techStacks: Record<string, string> = {}
    for (const row of rows) {
      const stackId = parseProjectSettings(row.settings)?.techStackId
      if (typeof stackId === 'string' && stackId) techStacks[row.id] = stackId
    }
    if (Object.keys(techStacks).length > 0) {
      env.WORKSPACE_TECH_STACKS = JSON.stringify(techStacks)
    }

    const loadAvailable =
      opts._loadAvailableProjects ??
      (async (id: string) => {
        const { prisma } = await import('../prisma')
        return (await prisma.project.findMany({
          where: { workspaceId: id },
          select: { id: true, name: true, description: true },
          orderBy: { name: 'asc' },
          take: 500,
        })) as Array<{ id: string; name: string | null; description?: string | null }>
      })
    const available = await loadAvailable(workspaceId)
    env.WORKSPACE_AVAILABLE_PROJECTS = JSON.stringify(
      available.map((project) => ({
        id: project.id,
        name: project.name || project.id,
        description: project.description ? project.description.slice(0, 240) : null,
      })),
    )
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

  // Workspace-level fallback token. A workspace with zero attached projects
  // (e.g. a brand-new personal companion — see the free-personal-space flow)
  // has no Project to hang a per-project AI_PROXY_TOKEN off, so the loop
  // above never runs and AI_PROXY_TOKEN is left unset. AI_PROXY_URL is
  // ALWAYS set a few lines down though, and the agent-runtime's
  // configureAIProxy() throws hard — poisoning the entire pod's
  // "Reconfigure" step — when the URL is set without a token (see
  // packages/agent/src/ai-proxy.ts). That failure surfaced in staging as
  // metal /pool/assign 400s → a generic "Something went wrong" for every
  // message sent from a project-less workspace chat.
  //
  // Mint one scoped to the 'workspace' sentinel projectId, which
  // ai-proxy.ts already treats as "not a real project" for billing
  // attribution — identical to the 'api-key' / 'system' sentinels handled
  // in recordUsage/recordImageUsage/recordTranscriptionUsage/
  // isTurnInFlight/touchRuntimeFor — so usage still bills against the
  // workspace owner instead of a Project FK that doesn't exist.
  if (!env.AI_PROXY_TOKEN) {
    try {
      const generate = opts._generateProxyToken ?? generateProxyToken
      const getWorkspaceOwner =
        opts._getWorkspaceOwnerUserId ??
        (async (id: string) => {
          const { getWorkspaceOwnerUserId } = await import('../project-user-context')
          return getWorkspaceOwnerUserId(id)
        })
      const ownerUserId = await getWorkspaceOwner(workspaceId)
      env.AI_PROXY_TOKEN = await generate('workspace', workspaceId, ownerUserId, 7 * 24 * 60 * 60 * 1000)
    } catch (err: any) {
      console.error(
        `[${prefix}] Failed to mint workspace-level fallback proxy token for ${workspaceId}:`,
        err?.message,
      )
    }
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

  // AI proxy URLs — identical resolution to build-project-env.ts, including the
  // metal case: Firecracker guests run OUTSIDE the OKE cluster, so in-cluster
  // service DNS is unresolvable and every LLM turn 502s with "Provider error:
  // Connection error". forMetal pins the URLs to the PUBLIC API base instead
  // (the guest egress-NATs to the internet; TLS + the project-scoped proxy
  // token keep it safe over the public path).
  const ns = process.env.SYSTEM_NAMESPACE
  const publicApiBase = (process.env.SHOGO_PUBLIC_API_URL || process.env.APP_URL || '').replace(/\/+$/, '')
  let apiBase: string
  if (opts.forMetal && publicApiBase) {
    apiBase = publicApiBase
  } else if (ns) {
    if (opts.forMetal) {
      console.error(
        `[${prefix}] metal env for workspace ${workspaceId} but SHOGO_PUBLIC_API_URL/APP_URL unset — ` +
          `AI proxy will be UNREACHABLE from the guest (falling back to in-cluster DNS)`,
      )
    }
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
  // Web search / Composio / embeddings proxy. Must end in `/api/tools` (see
  // buildToolsProxyUrl). Mirrors buildProjectEnv so workspace runtimes assigned
  // purely from this env (e.g. metal) can reach the tools proxy instead of
  // constructing an invalid `undefined/serper/search` URL.
  env.TOOLS_PROXY_URL = buildToolsProxyUrl(apiBase)

  // Cloud-connected local runtimes must use the cloud's model configuration;
  // local/offline runtimes use the local settings with entitlement capping.
  Object.assign(env, await resolveAgentModelEnv(workspaceId))

  // Super-admin sandbox-exec override (see sandbox-exec-setting.ts). `null` = no
  // override, leave SANDBOX_EXEC_ENABLED unset so the runtime falls back to its
  // own KUBERNETES_SERVICE_HOST heuristic.
  const sandboxOverride = getSandboxExecOverride()
  if (sandboxOverride !== null) env.SANDBOX_EXEC_ENABLED = String(sandboxOverride)

  // OTEL telemetry → SigNoz. Mirrors buildProjectEnv so metal-hosted workspace
  // runtimes emit traces/logs instead of going dark in observability. Endpoint
  // is SigNoz Cloud (public, reachable from the guest); the ingestion key comes
  // from a secretKeyRef on k8s, so we forward the literal value the API process
  // holds. Unreachable collectors never block the guest (bounded export timeout
  // in packages/core/src/instrumentation.ts).
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    env.OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    env.OTEL_SERVICE_NAME = 'shogo-runtime'
    if (process.env.SIGNOZ_INGESTION_KEY) {
      env.SIGNOZ_INGESTION_KEY = process.env.SIGNOZ_INGESTION_KEY
    }
  }

  // Public-facing URLs (OAuth callbacks for Composio `connect`, webchat embed
  // snippets). Mirrors buildProjectEnv / the Knative pod template. Both are
  // public URLs reachable from the metal guest's egress NAT.
  if (process.env.BETTER_AUTH_URL) {
    env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL
  }
  if (process.env.SHOGO_PUBLIC_API_URL) {
    env.SHOGO_PUBLIC_API_URL = process.env.SHOGO_PUBLIC_API_URL
  }

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
