import { describe, expect, mock, test } from 'bun:test'

const REQUIRED_LOCAL_ROUTES = [
  'GET /api/me',
  'POST /api/me/announcements/seen',
  'GET /api/me/activity',
  'POST /api/onboarding/complete',
  'GET /api/preview/:projectId/wake',
  'GET /api/preview/:projectId/open',
  'ALL /api/projects/:projectId/agent-proxy/*',
  'ALL /api/projects/:projectId/preview',
  'ALL /api/projects/:projectId/preview/*',
  'GET /api/projects/:projectId/preview/metro',
  'GET /api/projects/:projectId/terminal/sessions',
  'POST /api/projects/:projectId/terminal/sessions',
  'DELETE /api/projects/:projectId/terminal/sessions/:id',
  'GET /api/projects/:projectId/terminal/commands',
  'POST /api/projects/:projectId/diagnostics/terminal',
  'GET /api/projects/:projectId/heartbeat',
  'PATCH /api/projects/:projectId/heartbeat',
  'PUT /api/projects/:projectId/heartbeat/sync',
  'GET /api/projects/:projectId/thumbnail',
  'POST /api/projects/:projectId/thumbnail',
  'GET /api/projects/:projectId/thumbnail.png',
  'POST /api/projects/:projectId/thumbnail/capture',
  'POST /api/projects/:projectId/runtime/prewarm',
  'POST /api/generate-project-name',
  'GET /api/templates',
  'POST /api/workspaces/personal',
  'POST /api/workspaces/:id/leave',
  'GET /api/workspaces/:id/visible-models',
  'PUT /api/workspaces/:id/visible-models',
  'GET /api/types-proxy',
] as const

describe('local API route parity', () => {
  test('desktop-required routes are mounted in the local composer', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    mock.module('@shogo-ai/sdk/cli/pkg', () => ({
      pkg: { version: '0.0.0', name: '@shogo-ai/sdk' },
      PlatformPackageManager: class {},
      NodeMissingError: class NodeMissingError extends Error {
        constructor(m: string) {
          super(m)
          this.name = 'NodeMissingError'
        }
      },
      isNodeAvailableOnUnix: () => Promise.resolve(false),
      isNodeAvailableOnWindows: () => Promise.resolve(false),
      _resetUnixNodeCache: () => {},
      resolveBinInvocation: (command: string) => command,
    }))
    const { createLocalApp } = await import('../create-local-app')
    const { app } = createLocalApp()
    const routes = new Set(app.routes.map((route) => `${route.method} ${route.path}`))

    for (const route of REQUIRED_LOCAL_ROUTES) {
      expect(routes.has(route), `missing local route: ${route}`).toBe(true)
    }
  })
})
