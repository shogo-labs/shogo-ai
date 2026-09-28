import { describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'

const REQUIRED_LOCAL_ROUTES = [
  'GET /api/me',
  'POST /api/me/announcements/seen',
  'GET /api/me/activity',
  'GET /api/me/getting-started',
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
  'GET /api/workspaces/:workspaceId/schedules',
  'POST /api/workspaces/:workspaceId/schedules',
  'PATCH /api/workspaces/:workspaceId/schedules/:scheduleId',
  'DELETE /api/workspaces/:workspaceId/schedules/:scheduleId',
  'GET /api/types-proxy',
  // Called by the local agent-runtime; "Trust folder" is dead without it.
  'GET /api/internal/projects/:projectId/trust',
] as const

/** Runtime → API paths that intentionally only exist in the cloud API. */
const CLOUD_ONLY_RUNTIME_PATHS = new Set([
  // Publishing deploys to `*.shogo.one`; desktop has no publish pipeline.
  '/api/internal/projects/:param/publish',
])

const AGENT_RUNTIME_SRC = resolve(import.meta.dir, '../../../../../packages/agent-runtime/src')

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'evals' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (entry.name.endsWith('.ts')) yield full
  }
}

/**
 * Every `/api/internal/...` path the agent-runtime builds, with template
 * expressions (`${encodeURIComponent(id!)}`) collapsed to `:param` and query
 * strings dropped.
 */
function runtimeInternalPaths(): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of sourceFiles(AGENT_RUNTIME_SRC)) {
    const src = readFileSync(file, 'utf-8')
    let from = 0
    while ((from = src.indexOf('/api/internal/', from)) !== -1) {
      let path = ''
      let i = from
      while (i < src.length) {
        if (src.startsWith('${', i)) {
          let depth = 0
          for (; i < src.length; i++) {
            if (src[i] === '{') depth++
            else if (src[i] === '}' && --depth === 0) break
          }
          i++
          path += ':param'
          continue
        }
        if (/[\s`'"?]/.test(src[i]!)) break
        path += src[i]
        i++
      }
      from = i
      if (path.includes('...')) continue
      path = path.replace(/:[A-Za-z]+/g, ':param').replace(/(\/[^/:]+):param$/, '$1').replace(/\/$/, '')
      found.set(path, relative(AGENT_RUNTIME_SRC, file))
    }
  }
  return found
}

function normalizeRoutePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, ':param')
}

async function composeLocalApp() {
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_SKIP_STALE_RUNTIME_CLEANUP = '1'
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
  return createLocalApp().app
}

describe('local API route parity', () => {
  test('desktop-required routes are mounted in the local composer', async () => {
    const app = await composeLocalApp()
    const routes = new Set(app.routes.map((route) => `${route.method} ${route.path}`))

    for (const route of REQUIRED_LOCAL_ROUTES) {
      expect(routes.has(route), `missing local route: ${route}`).toBe(true)
    }
  })

  test('every internal path the agent-runtime calls is served by the local composer', async () => {
    const app = await composeLocalApp()
    const served = new Set(app.routes.map((route) => normalizeRoutePath(route.path)))
    const called = runtimeInternalPaths()
    expect(called.size).toBeGreaterThan(10)

    const missing = [...called]
      .filter(([path]) => !CLOUD_ONLY_RUNTIME_PATHS.has(path) && !served.has(path))
      .map(([path, file]) => `${path} (called from ${file})`)
    expect(missing, 'agent-runtime calls these /api/internal paths but desktop 404s them').toEqual([])
  })
})
