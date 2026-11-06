// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native release API: store credentials, the app mapping, and releases.
 *
 * Three routers, the same split `routes/social.ts` uses:
 *   `nativeReleaseRoutes()`       people, session auth, `/api/...`
 *   `nativeReleaseRelayRoutes()`  the cloud half of the desktop relay
 *   `nativeWebhookRoutes()`       EAS's BUILD/SUBMIT webhook
 *
 * No response from here ever contains a token or a credential: `credentials`
 * reads return `maskedHint` only, and the EAS token never leaves the API process
 * (see `services/native-release/client.ts`).
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { getWorkspaceRole } from '../services/conversation.service'
import {
  NativeReleaseError,
  deleteCredential,
  handleEasWebhook,
  listCredentials,
  nativeReleaseMode,
  saveCredential,
  sourcesUploaded,
  startRelease,
  validateAscKey,
  validatePlayKey,
  type CredentialKind,
  type ReleasePlatform,
  type ReleaseTrack,
} from '../services/native-release'
import { setAppIdentifiers } from '../services/native-release/apps.service'

const db = prisma as any

export interface NativeReleaseRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

function errorResponse(c: any, err: unknown) {
  if (err instanceof NativeReleaseError) {
    return c.json(err.toJSON(), err.status as any)
  }
  console.error('[native-release] unhandled', err)
  return c.json(
    { error: { code: 'native_release_failed', message: err instanceof Error ? err.message : 'Native release failed.' } },
    500,
  )
}

export function nativeReleaseRoutes(config: NativeReleaseRoutesConfig): Hono {
  const router = new Hono()

  async function requireMember(c: any, workspaceId: string): Promise<string | Response> {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in first' } }, 401)
    const role = await getWorkspaceRole(workspaceId, userId)
    if (!role) return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    if (role === 'viewer' && c.req.method !== 'GET') {
      return c.json({ error: { code: 'forbidden', message: 'Viewers cannot change app store settings' } }, 403)
    }
    return userId
  }

  async function requireProject(c: any, projectId: string): Promise<{ workspaceId: string; userId: string } | Response> {
    const project = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
    if (!project) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)
    const userId = await requireMember(c, project.workspaceId)
    if (userId instanceof Response) return userId
    return { workspaceId: project.workspaceId, userId }
  }

  router.get('/workspaces/:workspaceId/native/credentials', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    return c.json({ mode: nativeReleaseMode(), credentials: await listCredentials(workspaceId) })
  })

  router.put('/workspaces/:workspaceId/native/credentials/:kind', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId

    const kind = c.req.param('kind') as CredentialKind
    const payload = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

    try {
      const summary = await saveCredential(workspaceId, kind, payload, async (which, body) => {
        if (which === 'asc_api_key') {
          await validateAscKey({
            keyP8: String(body.keyP8 ?? ''),
            keyId: String(body.keyId ?? ''),
            issuerId: String(body.issuerId ?? ''),
            teamId: String(body.teamId ?? ''),
          })
          return
        }
        if (which === 'play_service_account') {
          await validatePlayKey(typeof body.json === 'string' ? body.json : JSON.stringify(body), {
            packageName: typeof body.packageName === 'string' ? body.packageName : undefined,
          })
        }
        // `expo_token` is validated by the first release that uses it: an Expo
        // token that fails here would mean a network round-trip on every keystroke
        // of the byok form, and `meActor` on the release path says the same thing.
      })
      return c.json({ credential: summary })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/workspaces/:workspaceId/native/credentials/:kind', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    await deleteCredential(workspaceId, c.req.param('kind') as CredentialKind)
    return c.json({ ok: true })
  })

  router.get('/projects/:projectId/native/app', async (c) => {
    const projectId = c.req.param('projectId')
    const auth = await requireProject(c, projectId)
    if (auth instanceof Response) return auth
    const app = await db.nativeApp.findUnique({ where: { projectId } })
    return c.json({ mode: nativeReleaseMode(), app })
  })

  router.put('/projects/:projectId/native/app', async (c) => {
    const projectId = c.req.param('projectId')
    const auth = await requireProject(c, projectId)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => ({}))) as Record<string, string | undefined>
    try {
      const app = await setAppIdentifiers(projectId, {
        bundleIdentifier: body.bundleIdentifier,
        androidPackage: body.androidPackage,
        ascAppId: body.ascAppId,
      })
      return c.json({ app })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/projects/:projectId/native/releases', async (c) => {
    const projectId = c.req.param('projectId')
    const auth = await requireProject(c, projectId)
    if (auth instanceof Response) return auth

    const body = (await c.req.json().catch(() => ({}))) as {
      platforms?: ReleasePlatform[]
      track?: ReleaseTrack
      fingerprint?: string
      hasMaestroFlows?: boolean
      jobDraft?: Record<string, unknown>
    }

    try {
      const result = await startRelease({
        workspaceId: auth.workspaceId,
        projectId,
        memberId: auth.userId,
        platforms: body.platforms ?? ['ios'],
        track: body.track ?? 'internal',
        fingerprint: body.fingerprint ?? 'unknown',
        hasMaestroFlows: body.hasMaestroFlows ?? false,
        jobDraft: body.jobDraft,
        apiBaseUrl: process.env.SHOGO_API_BASE_URL ?? 'https://api.shogo.ai',
      })
      return c.json(result, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/projects/:projectId/native/releases/:releaseId/sources', async (c) => {
    const projectId = c.req.param('projectId')
    const auth = await requireProject(c, projectId)
    if (auth instanceof Response) return auth

    const body = (await c.req.json().catch(() => ({}))) as {
      bucketKey?: string
      jobDraft?: Record<string, unknown>
    }
    if (!body.bucketKey) {
      return c.json({ error: { code: 'missing_bucket_key', message: 'bucketKey is required' } }, 400)
    }

    const release = await db.nativeRelease.findUnique({ where: { id: c.req.param('releaseId') } })
    if (!release || release.projectId !== projectId) {
      return c.json({ error: { code: 'not_found', message: 'Release not found' } }, 404)
    }

    try {
      const result = await sourcesUploaded({
        releaseId: release.id,
        bucketKey: body.bucketKey,
        jobDraft: body.jobDraft,
      })
      return c.json(result, 202)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/projects/:projectId/native/releases', async (c) => {
    const projectId = c.req.param('projectId')
    const auth = await requireProject(c, projectId)
    if (auth instanceof Response) return auth
    const releases = await db.nativeRelease.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { builds: true },
    })
    return c.json({ releases })
  })

  router.get('/projects/:projectId/native/releases/:releaseId', async (c) => {
    const projectId = c.req.param('projectId')
    const auth = await requireProject(c, projectId)
    if (auth instanceof Response) return auth
    const release = await db.nativeRelease.findFirst({
      where: { id: c.req.param('releaseId'), projectId },
      include: { builds: true },
    })
    if (!release) return c.json({ error: { code: 'not_found', message: 'Release not found' } }, 404)
    return c.json({ release })
  })

  return router
}

/**
 * The desktop half of the relay posts here with `SHOGO_API_KEY`; this is the only
 * side that holds an Expo token. Left as an explicit 501 until the desktop side
 * lands, so a relay client fails loudly instead of silently running BYOK.
 */
export function nativeReleaseRelayRoutes(): Hono {
  const router = new Hono()
  router.all('/native-release-relay/*', (c) =>
    c.json(
      {
        error: {
          code: 'relay_not_enabled',
          message: 'The native release relay is not enabled on this deployment yet.',
        },
      },
      501,
    ),
  )
  return router
}

export function nativeWebhookRoutes(): Hono {
  const router = new Hono()

  router.post('/webhooks/eas', async (c) => {
    const rawBody = await c.req.text()
    const result = await handleEasWebhook({
      rawBody,
      signature: c.req.header('expo-signature'),
      secret: process.env.EAS_WEBHOOK_SECRET,
      // One webhook per event, each with its own URL: Expo's payload has no
      // `event` field, so the query is the only reliable discriminator.
      event: c.req.query('event'),
    })
    return c.json(result.body, result.status as any)
  })

  return router
}
