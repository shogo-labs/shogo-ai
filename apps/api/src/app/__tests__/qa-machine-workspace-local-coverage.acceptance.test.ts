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

/**
 * An endpoint family: a client helper whose path ends in an argument rather
 * than a literal, e.g. `/api/workspaces/${workspaceId}/analytics/${endpoint}`.
 *
 * SHO-108 routed the analytics families to the machine (they used to sit in the
 * cloud pin, so this spec skipped them), which means the scan above can only
 * see `/analytics/x` — a path no route can ever match. Answering "is the tail
 * mounted?" from the call sites instead keeps the concrete-path assertion as
 * strict as it is while letting a dynamic family be checked honestly: the names
 * the app actually passes are the names the machine actually serves.
 */
type EndpointFn = { body: string; endpointIndex: number; families: Set<string> }

const WORKSPACE_ENDPOINT_PATH = /`(\/api\/workspaces\/\$\{[^}]+\}\/[a-z][a-z-]*\/\$\{\w+\})`/g
const SIGNATURES = [
  /(?:^|[\s;{}])(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g,
  /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:useCallback\s*\(\s*)?(?:<[^>]*>\s*)?\(/g,
  /(?:^|\n)\s*async\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g,
]

function enclosingName(src: string, index: number): string | null {
  const before = src.slice(0, index)
  let name: string | null = null
  let at = -1
  for (const re of SIGNATURES) {
    for (const m of before.matchAll(re)) {
      if ((m.index ?? -1) > at) {
        at = m.index ?? -1
        name = m[1]!
      }
    }
  }
  return name
}

function matchingParen(src: string, openParen: number): number {
  let depth = 0
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** `http, ws, 'usage-log', { … }` → ['http', 'ws', "'usage-log'", '{ … }'] at depth 0. */
function splitArgs(args: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!
    if (quote) {
      current += ch
      if (ch === quote && args[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if ('([{'.includes(ch)) depth++
    if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** The call's argument text, from the open paren to its matching close. */
function callArgsAt(src: string, openParen: number): string {
  const close = matchingParen(src, openParen)
  return close === -1 ? '' : src.slice(openParen + 1, close)
}

/**
 * The function's own text — a braced block, or an arrow's expression. Bounded
 * on purpose: a fixed-size window swallows the next method and hands a helper
 * its neighbour's family.
 */
function functionBody(src: string, openParen: number): string {
  const close = matchingParen(src, openParen)
  if (close === -1) return ''
  const after = src.slice(close + 1, close + 600)
  const brace = after.indexOf('{')
  const arrow = after.indexOf('=>')
  if (brace !== -1 && (arrow === -1 || brace <= arrow + 2)) {
    const from = close + 1 + brace
    let depth = 0
    for (let i = from; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(from, i + 1)
      }
    }
    return src.slice(from)
  }
  if (arrow !== -1) {
    // An expression body, which may itself span lines: run to the first
    // newline at bracket depth 0.
    let from = close + 1 + arrow + 2
    while (from < src.length && /\s/.test(src[from]!)) from++
    let depth = 0
    for (let i = from; i < src.length; i++) {
      const ch = src[i]!
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
      else if (ch === '\n' && depth === 0) return src.slice(from, i)
    }
    return src.slice(from)
  }
  return ''
}

/** A literal endpoint, or the template's variable segment folded to `:x`. */
function endpointLiteral(arg: string): string | null {
  const bare = arg.trim()
  const single = bare.match(/^(['"])([^'"`]+)\1$/)
  if (single) return single[2]!
  const template = bare.match(/^`([^`]*\$\{[^}]*\}[^`]*)`$/)
  if (template) return template[1]!.replace(/\$\{[^}]*\}/g, ':x')
  return null
}

type EndpointFamily = { template: string; callers: Set<string> }

/**
 * Endpoint families and the literals handed to them, all read from source:
 * the helper that builds the path, every pass-through that takes an `endpoint`
 * parameter and reaches it (`fetchSection` → `fetchCostAnalytics` → the API),
 * and each literal argument those pass-throughs receive.
 */
function endpointFamilies(): {
  families: Map<string, EndpointFamily>
  unresolved: string[]
} {
  const sources: Array<{ file: string; src: string }> = []
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(REPO, root))) {
      sources.push({ file, src: readFileSync(file, 'utf-8') })
    }
  }

  // helper name → the path template it builds
  const helpers = new Map<string, string>()
  for (const { src } of sources) {
    for (const m of src.matchAll(WORKSPACE_ENDPOINT_PATH)) {
      const name = enclosingName(src, m.index ?? 0)
      if (name) helpers.set(name, m[1]!)
    }
  }

  const fns = new Map<string, EndpointFn>()
  for (const { src } of sources) {
    for (const signature of SIGNATURES) {
      for (const m of src.matchAll(signature)) {
        const name = m[1]
        if (!name) continue
        const openParen = (m.index ?? 0) + m[0].length - 1
        const params = splitArgs(callArgsAt(src, openParen))
        const endpointIndex = params.findIndex((p) => /\bendpoint\b/.test(p))
        if (endpointIndex === -1) continue
        fns.set(name, {
          body: functionBody(src, openParen),
          endpointIndex,
          families: fns.get(name)?.families ?? new Set(),
        })
      }
    }
  }

  for (const [name, fn] of fns) {
    const own = helpers.get(name)
    if (own) fn.families.add(own)
    for (const [helper, template] of helpers) {
      if (name !== helper && new RegExp(`\\b${helper}\\b`).test(fn.body)) fn.families.add(template)
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    for (const [name, fn] of fns) {
      for (const [other, callee] of fns) {
        if (other === name) continue
        if (new RegExp(`\\b${other}\\b`).test(fn.body)) {
          for (const template of callee.families) fn.families.add(template)
        }
      }
    }
  }

  const families = new Map<string, EndpointFamily>()
  const unresolved: string[] = []
  for (const { file, src } of sources) {
    for (const [name, fn] of fns) {
      if (!fn.families.size) continue
      for (const m of src.matchAll(new RegExp(`\\b${name}\\s*(?:<[^>]*>)?\\s*\\(`, 'g'))) {
        const openParen = (m.index ?? 0) + m[0].length - 1
        const arg = splitArgs(callArgsAt(src, openParen))[fn.endpointIndex]
        const literal = arg ? endpointLiteral(arg) : null
        const where = `${relative(REPO, file)}:${name}`
        if (!literal) {
          unresolved.push(where)
          continue
        }
        for (const template of fn.families) {
          if (!families.has(template)) families.set(template, { template, callers: new Set() })
          families.get(template)!.callers.add(literal)
        }
      }
    }
  }
  return { families, unresolved }
}

/** Collapse the separator a placeholder leaves behind, so `/…/analytics//x` and `/…/analytics/x` compare. */
function stablePath(path: string): string {
  return path.replace(/\/{2,}/g, '/')
}

/** The path a resolved template leaves in the scan: `/…/analytics/${endpoint}` → `/…/analytics/x`. */
function dynamicPathOf(template: string): string {
  return stablePath(
    template
      .replace(/^\/api\/workspaces\/\$\{[^}]+\}/, '/api/workspaces/cloud-ws')
      .replace(/\$\{[^}]*\}/g, '/x'),
  )
}

/** Pull an endpoint into the template: the workspace segment stays a wildcard. */
function concretePath(template: string, endpoint: string): string {
  let seenWorkspace = false
  return template.replace(/\$\{[^}]*\}/g, () => {
    if (!seenWorkspace) {
      seenWorkspace = true
      return 'local-ws'
    }
    return endpoint === ':x' ? ':x' : endpoint
  })
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

    // Exactly the paths left behind by a helper whose endpoint is an argument —
    // nothing else. Skipping a whole family also skipped its literal-tail paths
    // (`/analytics/member-usage`, `/cost-analytics/agent-eval-sets`,
    // `/cost-analytics/subagent-overrides`), which the by-name test never sees
    // and which a real route can match.
    const resolvedDynamicPaths = new Set(
      [...endpointFamilies().families.keys()].map(dynamicPathOf),
    )
    const missing: string[] = []
    for (const [path, file] of clientWorkspacePaths()) {
      if (!shouldRouteToRemote(path, { machineWorkspaceId: 'local-ws' })) continue
      // A helper whose endpoint is an argument leaves only `/analytics/x`
      // behind — a shape no route can match — so those two paths are checked by
      // name in the test below. The skip is the resolver's own paths, not a
      // shape: skipping by shape dropped `/triggers/x`, `/goals/x` and
      // `/sessions/x/projects`, and skipping by family still dropped the
      // literal tails inside analytics/cost-analytics.
      if (resolvedDynamicPaths.has(stablePath(path))) continue
      const localPath = path.replace('/cloud-ws', '/local-ws')
      if (!localWorkspaceRoutes.some((re) => re.test(localPath))) {
        missing.push(`${path.replace('/api/workspaces/cloud-ws', '/api/workspaces/:id')}  (${file})`)
      }
    }
    expect(missing).toEqual([])
  }, 60_000)

  test('the endpoint families are the ones the app really calls', () => {
    // Teeth for the resolver: an empty map would make the next test vacuous.
    const { families, unresolved } = endpointFamilies()
    const templates = [...families.keys()]
    expect(templates).toContain('/api/workspaces/${workspaceId}/analytics/${endpoint}')
    expect(templates).toContain('/api/workspaces/${workspaceId}/cost-analytics/${endpoint}')
    // A family whose names the resolver dropped would make the test below pass
    // for the wrong reason, so every family has to arrive with its callers: the
    // usage panel alone passes six analytics names, and the cost tab's five
    // sections plus budget/experiments posts come through two pass-throughs.
    for (const { callers } of families.values()) {
      expect(callers.size).toBeGreaterThan(0)
    }
    expect(families.get('/api/workspaces/${workspaceId}/analytics/${endpoint}')!.callers.size).toBeGreaterThan(5)
    expect(families.get('/api/workspaces/${workspaceId}/cost-analytics/${endpoint}')!.callers.size).toBeGreaterThanOrEqual(5)

    // A call site whose tail is a runtime value is a place this spec cannot
    // look, so the set is pinned: a new one has to be added here, with its
    // reason, instead of quietly widening the blind spot. Each entry is a
    // pass-through that hands `endpoint` on from its own caller, whose literals
    // are checked in its place.
    expect([...unresolved].sort()).toEqual([
      'apps/mobile/components/analytics/CostAnalyticsTab.tsx:fetchCostAnalytics', // tab defs pick the section
      'apps/mobile/components/analytics/WorkspaceCostPanel.tsx:getWorkspaceCostAnalytics', // section param
      'apps/mobile/components/analytics/WorkspaceCostPanel.tsx:postWorkspaceCostAnalytics', // section param
      'apps/mobile/lib/api.ts:getWorkspaceAnalytics', // endpoint is the caller's argument
      'apps/mobile/lib/api.ts:getWorkspaceCostAnalytics', // endpoint is the caller's argument
      'apps/mobile/lib/api.ts:postWorkspaceCostAnalytics', // endpoint is the caller's argument
    ])
  })

  test('every endpoint name passed to a dynamic family is mounted by the local composer', async () => {
    const app = await composeLocalApp()
    // A wildcard is the composer's not-found fallback, not a route that serves
    // an endpoint — counting it would make every name below "mounted".
    const routes = app.routes
      .map((r) => r.path)
      .filter((p) => p.startsWith('/api/') && !p.includes('*'))

    const { families, unresolved } = endpointFamilies()
    const missing: string[] = []
    for (const { template, callers } of families.values()) {
      const family = template.match(/\/workspaces\/\$\{[^}]+\}\/([a-z][a-z-]*)\//)?.[1]
      if (!family) continue
      // A name read out of source is checked exactly like a literal path: if
      // the machine does not mount it, the call 404s the moment analytics is
      // opened on a machine workspace.
      for (const endpoint of callers) {
        const path = concretePath(template, endpoint)
        if (routes.some((route) => routeRegex(route).test(path))) continue
        missing.push(`${path.replace('local-ws', ':id')}  (${template})`)
      }
      // Call sites whose tail is a runtime value cannot be named from source.
      // Then the honest claim is narrower — the machine serves the family — and
      // the call sites are listed so the gap is visible, not assumed away.
      const prefix = new RegExp(`^/api/workspaces/[^/]+/${family}/`)
      if (!routes.some((route) => prefix.test(route))) {
        missing.push(`/api/workspaces/:id/${family}/…  (family not mounted; ${unresolved.join(', ')})`)
      }
    }
    expect(missing).toEqual([])
  }, 60_000)
})
