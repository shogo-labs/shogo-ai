/**
 * SHO-87 QA — every workspace-scoped call the app sends to a machine must be
 * served by the machine.
 *
 * While a machine workspace is open, the interceptor sends any
 * `/api/workspaces/<id>/…` request to the desktop's local API unless the path
 * is in `MACHINE_WORKSPACE_CLOUD_ONLY`. That inversion is right for team chat
 * (QA round 1), but it moves *every* workspace-scoped call, so a family that
 * only the cloud API mounts (server.ts) now 404s on the machine instead of
 * reaching the cloud. This spec reads every such path out of the app's own
 * source, asks the real interceptor where it goes, and requires that each
 * machine-bound path is mounted by the real local composer — so a new
 * cloud-only call fails here the day it is written.
 */
import { describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { shouldRouteToRemote } from '../../../../../packages/shared-app/src/services/remote-http-interceptor'

const REPO = resolve(import.meta.dir, '../../../../..')
const SCAN_ROOTS = [
  'apps/mobile/lib',
  'apps/mobile/components',
  'apps/mobile/hooks',
  'apps/mobile/app',
  'packages/sdk/src/platform',
  'packages/shared-app/src',
  'packages/domain-stores/src',
]

function* sourceFiles(dir: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full
  }
}

/**
 * Workspace-scoped paths handed to an HttpClient (the intercepted client):
 * template literals that *start* with `/api/workspaces/${…}/`. A literal that
 * starts with `${API_URL}` is a raw fetch and never sees the interceptor, so
 * it is not this spec's concern.
 */
function clientWorkspacePaths(): Map<string, string> {
  const found = new Map<string, string>()
  const re = /`\/api\/workspaces\/\$\{[^}]+\}(\/[^`?]*)/g
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(REPO, root))) {
      const src = readFileSync(file, 'utf-8')
      for (const m of src.matchAll(re)) {
        let rest = m[1]!.replace(/\/\$\{[^}]*\}/g, '/x').replace(/\$\{[^}]*\}/g, '').replace(/\/$/, '')
        if (!rest || rest.includes('${')) continue
        found.set(`/api/workspaces/cloud-ws${rest}`, relative(REPO, file))
      }
    }
  }
  return found
}

async function composeLocalApp() {
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_SKIP_STALE_RUNTIME_CLEANUP = '1'
  mock.module('@shogo-ai/sdk/cli/pkg', () => ({
    pkg: { version: '0.0.0', name: '@shogo-ai/sdk' },
    PlatformPackageManager: class {},
    NodeMissingError: class NodeMissingError extends Error {},
    isNodeAvailableOnUnix: () => Promise.resolve(false),
    isNodeAvailableOnWindows: () => Promise.resolve(false),
    _resetUnixNodeCache: () => {},
    resolveBinInvocation: (command: string) => command,
  }))
  const { createLocalApp } = await import('../create-local-app')
  return createLocalApp().app
}

function routeRegex(path: string): RegExp {
  const body = path
    .split('/')
    .map((seg) => (seg === '*' ? '.*' : seg.startsWith(':') ? '[^/]+' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${body}$`)
}

describe('SHO-87 QA: machine-bound workspace calls are served by the machine', () => {
  test('the scan finds the workspace-scoped calls (guard against an empty scan)', () => {
    const paths = clientWorkspacePaths()
    expect(paths.size).toBeGreaterThan(20)
  })

  test('every path the interceptor sends to the machine is mounted by the local composer', async () => {
    const app = await composeLocalApp()
    const localWorkspaceRoutes = app.routes
      .map((r) => r.path)
      .filter((p) => p.startsWith('/api/workspaces/'))
      .map(routeRegex)

    const missing: string[] = []
    for (const [path, file] of clientWorkspacePaths()) {
      if (!shouldRouteToRemote(path, { machineWorkspaceId: 'local-ws' })) continue
      const localPath = path.replace('/cloud-ws', '/local-ws')
      if (!localWorkspaceRoutes.some((re) => re.test(localPath))) {
        missing.push(`${path.replace('/api/workspaces/cloud-ws', '/api/workspaces/:id')}  (${file})`)
      }
    }
    expect(missing).toEqual([])
  }, 60_000)
})
