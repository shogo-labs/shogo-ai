// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * external-preview.ts
 *
 * Per-project endpoints that surface the dev-server URL state for the
 * desktop "External Preview" tab.
 *
 *   GET    /api/projects/:id/external-preview        → saved + detected
 *   PUT    /api/projects/:id/external-preview        → save manual URL
 *   DELETE /api/projects/:id/external-preview        → clear saved URL
 *
 * The "detected" half of the payload is sourced from the project's
 * agent-runtime, which sniffs PTY stdout for "Local: http://…" lines
 * (see `packages/agent-runtime/src/detected-urls.ts`). We don't try to
 * detect on the API side — only the runtime sees the user's terminal.
 *
 * The "saved" half lives in `Project.settings.externalPreview.savedUrl`.
 * We deliberately use the JSON `settings` blob rather than adding a new
 * column so this works across schemas without a migration; if the field
 * becomes hot enough to query, promoting it to a column is straightforward.
 *
 * URL validation: we only accept `http(s)://` URLs whose hostname is a
 * local host (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`). The
 * desktop view enforces this too, but we double-check at the API to
 * avoid persisting bogus state.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'

interface ExternalPreviewSettings {
  savedUrl?: string | null
}

interface ProjectSettingsLike {
  externalPreview?: ExternalPreviewSettings
  [k: string]: unknown
}

function isLocalHost(host: string): boolean {
  if (!host) return false
  const lower = host.toLowerCase()
  if (lower === 'localhost') return true
  if (lower === '127.0.0.1') return true
  if (lower === '0.0.0.0') return true
  if (lower === '[::1]' || lower === '::1') return true
  if (lower === '[::]' || lower === '::') return true
  if (lower.endsWith('.localhost')) return true
  return false
}

function validateUrl(
  raw: unknown,
  opts: { allowNonLocal: boolean },
): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'invalid_url' }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: 'malformed_url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'unsupported_protocol' }
  }
  if (!isLocalHost(parsed.hostname) && !opts.allowNonLocal) {
    return { ok: false, error: 'trust_required' }
  }
  return { ok: true, url: parsed.toString().replace(/\/$/, '') }
}

function readSavedUrl(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null
  const s = settings as ProjectSettingsLike
  const v = s.externalPreview?.savedUrl
  return typeof v === 'string' && v ? v : null
}

interface DetectedSnapshot {
  url: string
  sessionId: string
  detectedAt: number
}

interface DetectedPayload {
  detections: DetectedSnapshot[]
  mostRecent: DetectedSnapshot | null
}

/**
 * Fetch the agent-runtime's detected-URL snapshot.
 *
 * We deliberately do NOT trigger a runtime start here — folder-linked
 * projects often have `runtimeEnabled=false` and the user might just be
 * running their dev server in a terminal. If the runtime isn't already
 * up, we return `null` immediately; the renderer keeps polling, so as
 * soon as the runtime is started (via chat or the IDE panel) the next
 * poll will pick up the detected URL.
 */
async function fetchDetected(projectId: string): Promise<DetectedPayload | null> {
  try {
    // Lazy-import to keep this route module light; we never need the
    // manager for projects that don't have a hot runtime.
    const { getRuntimeManager } = await import('../lib/runtime/index')
    const manager = getRuntimeManager()
    const runtime = manager.status?.(projectId)
    if (!runtime || runtime.status !== 'running' || !runtime.agentPort) {
      return null
    }
    const host = (() => {
      try { return new URL(runtime.url ?? 'http://localhost').hostname || 'localhost' } catch { return 'localhost' }
    })()
    const base = `http://${host}:${runtime.agentPort}`
    const res = await fetch(`${base}/preview/detected-urls`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as DetectedPayload
    if (!body || !Array.isArray(body.detections)) return null
    return body
  } catch (err) {
    // ECONNREFUSED is the normal case while the runtime is still
    // booting — keep the noise level low.
    console.debug(`[ExternalPreview] detected-urls fetch failed for ${projectId}:`, (err as Error)?.message)
    return null
  }
}

export function externalPreviewRoutes() {
  const router = new Hono()

  router.get('/:id/external-preview', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)
    const projectId = c.req.param('id')

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workingMode: true, settings: true },
    })
    if (!project) return c.json({ error: 'project_not_found' }, 404)

    const savedUrl = readSavedUrl(project.settings)
    const detected = await fetchDetected(projectId)

    return c.json({
      projectId,
      workingMode: project.workingMode ?? 'managed',
      savedUrl,
      detectedUrl: detected?.mostRecent?.url ?? null,
      detections: detected?.detections ?? [],
    })
  })

  router.put('/:id/external-preview', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)
    const projectId = c.req.param('id')

    let body: { savedUrl?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, settings: true, trustLevel: true },
    })
    if (!project) return c.json({ error: 'project_not_found' }, 404)

    // Non-local URLs only land in the embedded webview if the user has
    // already trusted the workspace. The renderer prompts via
    // TrustPrompt; we double-check here so a stale tab can't poke a
    // restricted project into pointing at example.com.
    const allowNonLocal = project.trustLevel === 'trusted'
    const validated = validateUrl(body.savedUrl, { allowNonLocal })
    if (!validated.ok) {
      return c.json(
        {
          error: validated.error,
          needsTrust: validated.error === 'trust_required',
        },
        validated.error === 'trust_required' ? 403 : 400,
      )
    }

    const merged: ProjectSettingsLike = {
      ...((project.settings as ProjectSettingsLike) ?? {}),
      externalPreview: {
        ...(((project.settings as ProjectSettingsLike)?.externalPreview) ?? {}),
        savedUrl: validated.url,
      },
    }

    await prisma.project.update({
      where: { id: projectId },
      data: { settings: merged as never },
    })

    return c.json({ ok: true, savedUrl: validated.url })
  })

  router.delete('/:id/external-preview', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)
    const projectId = c.req.param('id')

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, settings: true },
    })
    if (!project) return c.json({ error: 'project_not_found' }, 404)

    const current = (project.settings as ProjectSettingsLike) ?? {}
    const nextSettings: ProjectSettingsLike = { ...current }
    if (nextSettings.externalPreview) {
      nextSettings.externalPreview = { ...nextSettings.externalPreview, savedUrl: null }
    }

    await prisma.project.update({
      where: { id: projectId },
      data: { settings: nextSettings as never },
    })

    return c.json({ ok: true, savedUrl: null })
  })

  return router
}
