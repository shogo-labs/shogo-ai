// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET …/projects/:projectId/preview-url
 *
 * SHO-322: on metal the runtime URL is the box's public DNAT
 * `http://<ip>:<port>` — internal plumbing, not a link a person can open. The
 * route must answer with the project's `*.preview.<base>` origin, and the
 * runtime URL must stay out of the user-facing field. Everything else
 * (local/desktop, other substrates) keeps today's behaviour.
 *
 *   bun test ./apps/api/src/routes/__tests__/workspace-chat-preview-url.test.ts
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

process.env.PREVIEW_BASE_DOMAIN ||= 'preview.test'

const store = {
  metal: true,
  podUrl: 'http://10.0.0.9:20011',
  attached: ['proj-1'],
  anchor: 'proj-anchor',
}

const realWorkspaceService = await import('../../services/workspace.service')
mock.module('../../services/workspace.service', () => ({
  ...realWorkspaceService,
  getWorkspaceKind: async () => 'team',
  loadWorkspaceContext: async () => ({ hasAccess: true, kind: 'team' }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

const realSessionService = await import('../../services/workspace-session.service')
mock.module('../../services/workspace-session.service', () => ({
  ...realSessionService,
  WorkspaceSessionError: realSessionService.WorkspaceSessionError,
  assertWorkspaceSessionAccess: async () => {},
  upgradeProjectSessionToWorkspace: async () => null,
}))

mock.module('../../lib/workspace-runtime-args', () => ({
  readWorkspaceSessionRuntimeArgs: async () => ({
    attachedProjectIds: [...store.attached],
    extra: { anchorProjectId: store.anchor },
  }),
}))

const realChatRuntimeFetch = await import('../../lib/chat-runtime-fetch')
mock.module('../../lib/chat-runtime-fetch', () => ({
  ...realChatRuntimeFetch,
  isMetalSingleRuntime: () => store.metal,
  runtimeMembers: (ids: string[]) => ids,
}))

mock.module('../../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ mode: 'metal', url: store.podUrl }),
}))

mock.module('../../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async () => ({ mode: 'k8s', url: 'http://ws-1.shogo-workspaces.svc.cluster.local:8080' }),
  }
})

mock.module('../../lib/chat-region-pin', () => ({
  WORKSPACE_RUNTIME_ROUTE_PATTERNS: [],
  pinWorkspaceRoutesToHomeRegion: () => async (_c: any, next: () => Promise<void>) => next(),
  pinChatToHomeRegion: async () => null,
}))

mock.module('../../lib/prisma', () => ({
  Prisma: {},
  InstanceKind: { desktop: 'desktop', cli_worker: 'cli_worker' },
  prisma: {
    chatSession: { findUnique: async () => ({ contextId: null }) },
    projectFolder: { findMany: async () => [] },
  },
}))

const { workspaceChatRoutes } = await import('../workspace-chat')
const { getPreviewUrl } = await import('../../lib/knative-project-manager')

const { Hono } = require('hono')
const router = workspaceChatRoutes({ resolveUserId: async () => 'user-1', runtimeManager: {} as any })
const app = new Hono()
app.route('/api', router)

function previewUrl(projectId = 'proj-1') {
  return app.fetch(
    new Request(`http://x/api/workspaces/ws-1/sessions/s-1/projects/${projectId}/preview-url`),
  )
}

beforeEach(() => {
  process.env.PREVIEW_BASE_DOMAIN = 'preview.test'
  store.metal = true
  store.podUrl = 'http://10.0.0.9:20011'
  store.attached = ['proj-1']
  store.anchor = 'proj-anchor'
})

describe('GET …/preview-url', () => {
  test('metal: answers the public preview origin, never the box address', async () => {
    const res = await previewUrl()
    expect(res.status).toBe(200)
    const body: any = await res.json()

    expect(body.mode).toBe('metal')
    expect(body.previewUrl).toBe(`${getPreviewUrl('proj-1')}/p/proj-1/`)
    expect(JSON.stringify(body.previewUrl)).not.toContain('10.0.0.9')
    expect(JSON.stringify(body)).not.toContain('http://10.0.0.9:20011/p/')
  })

  test('metal without a configured preview domain keeps the runtime url (local/desktop)', async () => {
    delete process.env.PREVIEW_BASE_DOMAIN
    const res = await previewUrl()
    const body: any = await res.json()
    expect(body.previewUrl).toBe('http://10.0.0.9:20011/p/proj-1/')
  })

  test('other substrates are unchanged', async () => {
    store.metal = false
    const res = await previewUrl()
    const body: any = await res.json()
    expect(body.mode).toBe('k8s')
    expect(body.previewUrl).toBe('http://ws-1.shogo-workspaces.svc.cluster.local:8080/p/proj-1/')
  })
})
