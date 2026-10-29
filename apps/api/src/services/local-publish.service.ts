// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Publishing from the desktop (SHO-245).
 *
 * The desktop has no hosting pipeline of its own — but the project's files are
 * right here, so it CAN build them. The cloud has the hosting — but it can
 * never see a desktop project's files. So a desktop publish is:
 *
 *   1. build the bundle in the project's LOCAL runtime (`/agent/publish-build`)
 *   2. read it back (`/agent/dist-files?publish=true`)
 *   3. upload it to the cloud's `POST /api/published-sites/:sourceProjectId`
 *      with the connected `SHOGO_API_KEY`
 *   4. mirror the result onto the LOCAL Project row, so `GET` and the publish
 *      panel show the real state and machine sync carries it up like any other
 *      row
 *
 * This replaces the old `proxyPublishToCloud` middleware, which forwarded the
 * request to cloud routes that build from a cloud pod — a pod that never has a
 * desktop project's files — so it could only ever 404 or fail.
 *
 * Static only. A server-backed project (its published app needs `server.tsx` /
 * `custom-routes.ts`) is refused with `server_backed_requires_cloud_project`
 * rather than published as a half-working site.
 */

import { prisma } from '../lib/prisma'
import { getUpstreamCredential } from '../lib/federated-upstream'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import { hashSitePassword } from '../lib/cloudflare-site-auth-kv'

/** A publish can take minutes (install + build + upload); don't cut it short. */
const LOCAL_PUBLISH_BUILD_TIMEOUT_MS = 180_000
const LOCAL_PUBLISH_DOWNLOAD_TIMEOUT_MS = 120_000
const LOCAL_PUBLISH_UPLOAD_TIMEOUT_MS = 180_000
const LOCAL_PUBLISH_PROBE_TIMEOUT_MS = 15_000

/** localConfig key: local project id → cloud host project id. */
const PUBLISH_HOSTS_KEY = 'CLOUD_PUBLISH_HOSTS'

export type LocalPublishAccessLevel = 'anyone' | 'authenticated' | 'private' | 'password'

export interface LocalPublishOptions {
  subdomain?: string
  accessLevel?: LocalPublishAccessLevel
  password?: string
  siteTitle?: string
  siteDescription?: string
}

export interface LocalPublishResult {
  ok: boolean
  status: number
  url?: string
  subdomain?: string
  publishedAt?: number
  accessLevel?: LocalPublishAccessLevel
  hasPassword?: boolean
  code?: string
  message?: string
}

/**
 * Everything this service touches that a unit test needs to control: the local
 * runtime URL/token, the cloud key + base URL, and `fetch` itself.
 */
export interface LocalPublishDeps {
  resolveRuntimeUrl(projectId: string): Promise<string>
  runtimeToken(projectId: string, workspaceId?: string | null): Promise<string>
  cloudKey(): Promise<string | null>
  cloudUrl(): string
  fetch: typeof fetch
}

const defaultDeps: LocalPublishDeps = {
  async resolveRuntimeUrl(projectId) {
    const { resolveProjectPodUrl } = await import('../lib/resolve-pod-url')
    const resolved = await resolveProjectPodUrl(projectId, { logTag: 'LocalPublish' })
    return resolved.url
  },
  async runtimeToken(projectId, workspaceId) {
    const { deriveProjectRuntimeToken } = await import('../lib/project-runtime-token')
    return deriveProjectRuntimeToken(projectId, { workspaceId })
  },
  cloudKey: () => getUpstreamCredential(),
  cloudUrl: () => getShogoCloudUrl(),
  // Late-bound so a test (or a runtime that swaps global fetch) is honoured.
  fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch,
}

function withDeps(overrides: Partial<LocalPublishDeps> | undefined): LocalPublishDeps {
  return { ...defaultDeps, ...(overrides ?? {}) }
}

// ─── local → cloud host project registry (localConfig-backed) ───────────────

export async function readPublishHosts(): Promise<Record<string, string>> {
  try {
    const row = await (prisma as any).localConfig
      .findUnique({ where: { key: PUBLISH_HOSTS_KEY } })
      .catch(() => null)
    if (!row?.value) return {}
    const parsed = JSON.parse(row.value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [localId, hostId] of Object.entries(parsed)) {
      if (typeof hostId === 'string' && hostId) out[localId] = hostId
    }
    return out
  } catch {
    return {}
  }
}

async function writePublishHost(localProjectId: string, hostProjectId: string | null): Promise<void> {
  try {
    const hosts = await readPublishHosts()
    if (hostProjectId) hosts[localProjectId] = hostProjectId
    else delete hosts[localProjectId]
    const value = JSON.stringify(hosts)
    await (prisma as any).localConfig.upsert({
      where: { key: PUBLISH_HOSTS_KEY },
      update: { value },
      create: { key: PUBLISH_HOSTS_KEY, value },
    })
  } catch (err: any) {
    // Diagnostics only — never fail a publish over the mapping.
    console.warn(`[LocalPublish] could not record host project for ${localProjectId}:`, err?.message ?? err)
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function setLocalPublishStatus(
  projectId: string,
  status: 'idle' | 'building' | 'uploading' | 'live' | 'failed',
  errorCode: string | null = null,
): Promise<void> {
  try {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        publishStatus: status as any,
        publishError: errorCode,
        publishStatusAt: new Date(),
      },
    })
  } catch (err: any) {
    console.warn(`[LocalPublish] setPublishStatus(${projectId}, ${status}) failed:`, err?.message ?? err)
  }
}

function timedOut(err: any): boolean {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError'
}

function cloudError(
  status: number,
  body: any,
  fallback: string,
): LocalPublishResult {
  const code = body?.error?.code ?? body?.code
  const message = body?.error?.message ?? body?.error ?? body?.message
  // The cloud rejects a missing/expired key with a 401. Surface that as an
  // actionable sign-in prompt rather than "not authorized".
  if (status === 401) {
    return {
      ok: false,
      status: 503,
      code: 'cloud_signin_required',
      message: typeof message === 'string' ? message : 'Sign in to Shogo Cloud to publish.',
    }
  }
  return {
    ok: false,
    status: status >= 400 && status < 600 ? status : 502,
    code: typeof code === 'string' ? code : 'publish_failed',
    message: typeof message === 'string' ? message : fallback,
  }
}

/** Ask the project's local runtime whether its published app needs a server. */
async function isServerBacked(projectId: string, runtimeUrl: string, token: string, f: typeof fetch): Promise<boolean> {
  try {
    const res = await f(`${runtimeUrl}/agent/server-info?projectId=${encodeURIComponent(projectId)}`, {
      headers: { 'x-runtime-token': token },
      signal: AbortSignal.timeout(LOCAL_PUBLISH_PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return false
    const info = (await res.json().catch(() => null)) as { serverBacked?: boolean } | null
    return info?.serverBacked === true
  } catch {
    // A probe failure must never switch a working static app onto a path that
    // can't host it.
    return false
  }
}

/**
 * Build the bundle in the project's local runtime and read it back.
 * Returns base64-per-file entries, the same shape `/agent/dist-files` produces.
 */
async function buildBundle(
  projectId: string,
  deps: LocalPublishDeps,
): Promise<
  | { ok: true; files: Array<{ path: string; content: string }> }
  | { ok: false; status: number; code: string; message: string }
> {
  const runtimeUrl = (await deps.resolveRuntimeUrl(projectId)).replace(/\/$/, '')
  const token = await deps.runtimeToken(projectId)

  if (await isServerBacked(projectId, runtimeUrl, token, deps.fetch)) {
    return {
      ok: false,
      status: 400,
      code: 'server_backed_requires_cloud_project',
      message:
        'This app has a server (server.tsx / custom-routes.ts), which the desktop cannot host on a subdomain. ' +
        'Sync the project to Shogo Cloud and publish it from there.',
    }
  }

  await setLocalPublishStatus(projectId, 'building')

  let build: Response
  try {
    build = await deps.fetch(`${runtimeUrl}/agent/publish-build?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': token },
      signal: AbortSignal.timeout(LOCAL_PUBLISH_BUILD_TIMEOUT_MS),
    })
  } catch (err: any) {
    await setLocalPublishStatus(projectId, 'failed', timedOut(err) ? 'build_timeout' : 'build_failed')
    return {
      ok: false,
      status: timedOut(err) ? 504 : 500,
      code: timedOut(err) ? 'build_timeout' : 'build_failed',
      message: timedOut(err)
        ? `The publish build did not finish in ${LOCAL_PUBLISH_BUILD_TIMEOUT_MS / 1000}s.`
        : `Could not reach the project runtime to build it: ${err?.message ?? err}`,
    }
  }

  const buildBody = (await build.json().catch(() => null)) as { ok?: boolean; error?: string } | null
  if (!build.ok || buildBody?.ok !== true) {
    const code = 'build_failed'
    await setLocalPublishStatus(projectId, 'failed', code)
    return {
      ok: false,
      status: 500,
      code,
      message: buildBody?.error || `The publish build failed (HTTP ${build.status}).`,
    }
  }

  let dist: Response
  try {
    dist = await deps.fetch(
      `${runtimeUrl}/agent/dist-files?projectId=${encodeURIComponent(projectId)}&publish=true`,
      { headers: { 'x-runtime-token': token }, signal: AbortSignal.timeout(LOCAL_PUBLISH_DOWNLOAD_TIMEOUT_MS) },
    )
  } catch (err: any) {
    await setLocalPublishStatus(projectId, 'failed', timedOut(err) ? 'download_timeout' : 'download_failed')
    return {
      ok: false,
      status: timedOut(err) ? 504 : 500,
      code: timedOut(err) ? 'download_timeout' : 'download_failed',
      message: `Could not read the build output: ${err?.message ?? err}`,
    }
  }

  if (!dist.ok) {
    await setLocalPublishStatus(projectId, 'failed', 'download_failed')
    return {
      ok: false,
      status: 500,
      code: 'download_failed',
      message: `Could not read the build output (HTTP ${dist.status}).`,
    }
  }

  const files = (await dist.json().catch(() => null)) as Array<{ path: string; content: string }> | null
  if (!Array.isArray(files) || files.length === 0) {
    await setLocalPublishStatus(projectId, 'failed', 'no_files')
    return { ok: false, status: 400, code: 'no_files', message: 'The build produced no files to publish.' }
  }

  return { ok: true, files }
}

/**
 * Persist the cloud's answer onto the LOCAL project row: the panel reads this,
 * and machine sync carries it up like any other row.
 */
async function mirrorPublishState(
  projectId: string,
  opts: {
    subdomain: string
    accessLevel: LocalPublishAccessLevel
    password?: string
    siteTitle?: string
    siteDescription?: string
    existingHash: string | null
    existingSubdomain: string | null
    publishedAt: Date
  },
): Promise<string | null> {
  let hash: string | null = null
  if (opts.accessLevel === 'password') {
    if (typeof opts.password === 'string' && opts.password.length > 0) {
      // Same salt the cloud/edge use, so the local row reports `hasPassword`
      // truthfully and matches the gate that is actually enforced.
      hash = hashSitePassword(opts.subdomain, opts.password)
    } else if (opts.existingHash && opts.existingSubdomain === opts.subdomain) {
      hash = opts.existingHash
    }
  }
  try {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        publishedSubdomain: opts.subdomain,
        publishedAt: opts.publishedAt,
        publishStatus: 'live' as any,
        publishError: null,
        publishStatusAt: opts.publishedAt,
        accessLevel: opts.accessLevel as any,
        sitePasswordHash: hash,
        ...(opts.siteTitle !== undefined ? { siteTitle: opts.siteTitle } : {}),
        ...(opts.siteDescription !== undefined ? { siteDescription: opts.siteDescription } : {}),
      } as any,
    })
  } catch (err: any) {
    console.warn(`[LocalPublish] could not mirror publish state for ${projectId}:`, err?.message ?? err)
  }
  return hash
}

// ─── public surface ─────────────────────────────────────────────────────────

/** Current publish state for the panel — read straight off the local row. */
export async function localPublishState(projectId: string) {
  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      publishedSubdomain: true,
      publishedAt: true,
      accessLevel: true,
      sitePasswordHash: true,
      siteTitle: true,
      siteDescription: true,
      publishStatus: true,
      publishError: true,
    } as any,
  })) as Record<string, any> | null
  if (!project) {
    return { ok: false as const, status: 404, code: 'project_not_found', message: 'Project not found' }
  }
  const hosts = await readPublishHosts()
  return {
    ok: true as const,
    subdomain: project.publishedSubdomain ?? undefined,
    publishedAt: project.publishedAt ? new Date(project.publishedAt).getTime() : undefined,
    accessLevel: project.accessLevel ?? undefined,
    hasPassword: !!project.sitePasswordHash,
    siteTitle: project.siteTitle ?? undefined,
    siteDescription: project.siteDescription ?? undefined,
    publishStatus: project.publishStatus ?? undefined,
    publishError: project.publishError ?? undefined,
    // Desktop-only: whether a cloud key is connected decides if publishing can
    // work at all, and the panel disables the button when it can't.
    cloudConnected: !!(await getUpstreamCredential()),
    cloudHostProjectId: hosts[projectId] ?? undefined,
    publishDomain: process.env.PUBLISH_DOMAIN || 'shogo.one',
  }
}

/**
 * Publish (or republish) a desktop project to `{subdomain}.shogo.one`.
 *
 * Omit `subdomain` to redeploy onto the live one — that is the republish path,
 * and what the agent's `publish` tool means when the user says "publish again".
 */
export async function localPublishProject(
  projectId: string,
  opts: LocalPublishOptions = {},
  overrides?: Partial<LocalPublishDeps>,
): Promise<LocalPublishResult> {
  const deps = withDeps(overrides)

  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      workspaceId: true,
      publishedSubdomain: true,
      sitePasswordHash: true,
      accessLevel: true,
      siteTitle: true,
      siteDescription: true,
    } as any,
  })) as Record<string, any> | null
  if (!project) {
    return { ok: false, status: 404, code: 'project_not_found', message: 'Project not found' }
  }

  const cloudKey = await deps.cloudKey()
  if (!cloudKey) {
    return {
      ok: false,
      status: 503,
      code: 'cloud_signin_required',
      message: 'Sign in to Shogo Cloud to publish — the published site is hosted there.',
    }
  }

  const requested = (opts.subdomain ?? '').trim().toLowerCase()
  const subdomain = requested || (project.publishedSubdomain ?? '')
  if (!subdomain) {
    return {
      ok: false,
      status: 400,
      code: 'subdomain_required',
      message: 'A subdomain is required for the first publish.',
    }
  }

  const accessLevel = (opts.accessLevel ?? (project.accessLevel as LocalPublishAccessLevel) ?? 'anyone')
  const siteTitle = opts.siteTitle !== undefined ? opts.siteTitle : (project.siteTitle ?? undefined)
  const siteDescription =
    opts.siteDescription !== undefined ? opts.siteDescription : (project.siteDescription ?? undefined)

  const bundle = await buildBundle(projectId, deps)
  if (!bundle.ok) return bundle

  await setLocalPublishStatus(projectId, 'uploading')

  let upstream: Response
  try {
    upstream = await deps.fetch(
      `${deps.cloudUrl().replace(/\/$/, '')}/api/published-sites/${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cloudKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          files: bundle.files,
          subdomain,
          accessLevel,
          ...(opts.password !== undefined ? { password: opts.password } : {}),
          ...(siteTitle !== undefined ? { siteTitle } : {}),
          ...(siteDescription !== undefined ? { siteDescription } : {}),
        }),
        signal: AbortSignal.timeout(LOCAL_PUBLISH_UPLOAD_TIMEOUT_MS),
      },
    )
  } catch (err: any) {
    await setLocalPublishStatus(projectId, 'failed', timedOut(err) ? 'upload_timeout' : 'cloud_unreachable')
    return {
      ok: false,
      status: timedOut(err) ? 504 : 502,
      code: timedOut(err) ? 'upload_timeout' : 'cloud_unreachable',
      message: timedOut(err)
        ? `Uploading the site to Shogo Cloud did not finish in ${LOCAL_PUBLISH_UPLOAD_TIMEOUT_MS / 1000}s.`
        : `Could not reach Shogo Cloud: ${err?.message ?? err}`,
    }
  }

  const body = (await upstream.json().catch(() => null)) as any
  if (!upstream.ok) {
    const failure = cloudError(upstream.status, body, `Publishing to Shogo Cloud failed (HTTP ${upstream.status}).`)
    await setLocalPublishStatus(projectId, 'failed', failure.code ?? 'publish_failed')
    return failure
  }

  const publishedAt = new Date()
  const liveSubdomain = typeof body?.subdomain === 'string' && body.subdomain ? body.subdomain : subdomain
  const liveAccessLevel = (body?.accessLevel as LocalPublishAccessLevel) ?? accessLevel
  const hash = await mirrorPublishState(projectId, {
    subdomain: liveSubdomain,
    accessLevel: liveAccessLevel,
    password: opts.password,
    siteTitle,
    siteDescription,
    existingHash: (project.sitePasswordHash as string | null) ?? null,
    existingSubdomain: (project.publishedSubdomain as string | null) ?? null,
    publishedAt,
  })
  if (typeof body?.hostProjectId === 'string' && body.hostProjectId) {
    await writePublishHost(projectId, body.hostProjectId)
  }

  return {
    ok: true,
    status: 200,
    url: typeof body?.url === 'string' && body.url ? body.url : `https://${liveSubdomain}.${process.env.PUBLISH_DOMAIN || 'shogo.one'}`,
    subdomain: liveSubdomain,
    publishedAt: publishedAt.getTime(),
    accessLevel: liveAccessLevel,
    hasPassword: !!hash,
  }
}

/** Redeploy the current build onto the live subdomain. */
export async function localRepublishProject(
  projectId: string,
  overrides?: Partial<LocalPublishDeps>,
): Promise<LocalPublishResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { publishedSubdomain: true },
  })
  if (!project) {
    return { ok: false, status: 404, code: 'project_not_found', message: 'Project not found' }
  }
  if (!project.publishedSubdomain) {
    return { ok: false, status: 400, code: 'not_published', message: 'Project is not published' }
  }
  return localPublishProject(projectId, { subdomain: project.publishedSubdomain }, overrides)
}

/** Change visitor settings on an already-published desktop project. */
export async function localUpdatePublishSettings(
  projectId: string,
  settings: {
    accessLevel?: LocalPublishAccessLevel
    password?: string
    siteTitle?: string
    siteDescription?: string
  },
  overrides?: Partial<LocalPublishDeps>,
): Promise<LocalPublishResult> {
  const deps = withDeps(overrides)

  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { publishedSubdomain: true, sitePasswordHash: true },
  })) as Record<string, any> | null
  if (!project) {
    return { ok: false, status: 404, code: 'project_not_found', message: 'Project not found' }
  }
  if (!project.publishedSubdomain) {
    return { ok: false, status: 400, code: 'not_published', message: 'Project is not published' }
  }

  const cloudKey = await deps.cloudKey()
  if (!cloudKey) {
    return {
      ok: false,
      status: 503,
      code: 'cloud_signin_required',
      message: 'Sign in to Shogo Cloud to change published-site settings.',
    }
  }

  let upstream: Response
  try {
    upstream = await deps.fetch(
      `${deps.cloudUrl().replace(/\/$/, '')}/api/published-sites/${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${cloudKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(settings),
        signal: AbortSignal.timeout(LOCAL_PUBLISH_PROBE_TIMEOUT_MS * 4),
      },
    )
  } catch (err: any) {
    return {
      ok: false,
      status: 502,
      code: 'cloud_unreachable',
      message: `Could not reach Shogo Cloud: ${err?.message ?? err}`,
    }
  }

  const body = (await upstream.json().catch(() => null)) as any
  if (!upstream.ok) return cloudError(upstream.status, body, `Updating the published site failed (HTTP ${upstream.status}).`)

  const accessLevel = (body?.accessLevel as LocalPublishAccessLevel) ?? (settings.accessLevel ?? 'anyone')
  const subdomain = (body?.subdomain as string) || project.publishedSubdomain
  const hash = await mirrorPublishState(projectId, {
    subdomain,
    accessLevel,
    password: settings.password,
    siteTitle: settings.siteTitle,
    siteDescription: settings.siteDescription,
    existingHash: (project.sitePasswordHash as string | null) ?? null,
    existingSubdomain: project.publishedSubdomain,
    publishedAt: new Date(),
  })

  return {
    ok: true,
    status: 200,
    url: `https://${subdomain}.${process.env.PUBLISH_DOMAIN || 'shogo.one'}`,
    subdomain,
    accessLevel,
    hasPassword: !!hash,
  }
}

/** Take the site down: the cloud clears its host project, we clear our row. */
export async function localUnpublishProject(
  projectId: string,
  overrides?: Partial<LocalPublishDeps>,
): Promise<LocalPublishResult> {
  const deps = withDeps(overrides)

  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { publishedSubdomain: true },
  })) as Record<string, any> | null
  if (!project) {
    return { ok: false, status: 404, code: 'project_not_found', message: 'Project not found' }
  }
  if (!project.publishedSubdomain) {
    return { ok: false, status: 400, code: 'not_published', message: 'Project is not published' }
  }

  const cloudKey = await deps.cloudKey()
  if (!cloudKey) {
    return {
      ok: false,
      status: 503,
      code: 'cloud_signin_required',
      message: 'Sign in to Shogo Cloud to unpublish — the site is hosted there.',
    }
  }

  let upstream: Response
  try {
    upstream = await deps.fetch(
      `${deps.cloudUrl().replace(/\/$/, '')}/api/published-sites/${encodeURIComponent(projectId)}/unpublish`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${cloudKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(LOCAL_PUBLISH_PROBE_TIMEOUT_MS * 4),
      },
    )
  } catch (err: any) {
    return {
      ok: false,
      status: 502,
      code: 'cloud_unreachable',
      message: `Could not reach Shogo Cloud: ${err?.message ?? err}`,
    }
  }

  const body = (await upstream.json().catch(() => null)) as any
  // `not_published` from the cloud means the host row is already clear, which
  // is exactly the state an unpublish wants — keep clearing locally.
  if (!upstream.ok && body?.error?.code !== 'not_published') {
    return cloudError(upstream.status, body, `Unpublishing failed (HTTP ${upstream.status}).`)
  }

  await prisma.project.update({
    where: { id: projectId },
    data: {
      publishedSubdomain: null,
      publishedAt: null,
      publishStatus: 'idle' as any,
      publishError: null,
      publishStatusAt: new Date(),
      accessLevel: 'anyone',
      sitePasswordHash: null,
      siteTitle: null,
      siteDescription: null,
    } as any,
  })
  await writePublishHost(projectId, null)

  return { ok: true, status: 200 }
}
