// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-63 — `system_apply` must fail loudly or not at all.
 *
 * The network boundary is a real HTTP server that behaves like the workspace
 * API in the reported failure: an `attach` POST from the workspace anchor id
 * answers `401 Unauthorized` (no project identity to attach *from*), while an
 * attach from a real project anchor succeeds. `system_apply`, the manifest
 * loader, the lock file, the diff and the on-disk file writes all run as
 * themselves — nothing is mocked at the module level.
 *
 * What the card requires, and what is asserted here:
 *  - a workspace-agent apply of an anchor-less manifest is `ok: true` with no
 *    attach errors and no request to the caller edge, while declared
 *    project-to-project attaches still happen;
 *  - a lock entry for a project that exists but is not mounted here is a
 *    `configure`, never a second copy; one nobody can see stays `inaccessible`;
 *  - a file op against an unmounted project is `skip: project_not_mounted`
 *    with `ok: true` and no claimed create;
 *  - a fully-mounted manifest still reports an empty diff on the second run.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Hit = { method: string; path: string; body: any }

const hits: Hit[] = []
let server: Server
let port = 0

/** Live project-graph nodes the fake API returns. */
let graph: any[] = []
/** Workspace project list (`GET .../projects`) — every project the caller can reach. */
let workspaceProjects: any[] = []
/** Anchor ids whose `/attachments` POST answers 401, like the real workspace agent. */
const unauthorizedAnchors = new Set<string>()
let createdProjectSeq = 0

const savedEnv = new Map<string, string | undefined>()
function setEnv(key: string, value: string | undefined) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
}

function send(res: any, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      const body = raw ? (() => { try { return JSON.parse(raw) } catch { return raw } })() : null
      const path = url.pathname
      hits.push({ method: req.method ?? 'GET', path, body })

      if (req.method === 'GET' && /^\/api\/internal\/workspaces\/[^/]+\/projects\/graph$/.test(path)) {
        return send(res, 200, { workspaceId: 'ws-1', projects: graph })
      }
      if (req.method === 'GET' && /^\/api\/internal\/workspaces\/[^/]+\/projects$/.test(path)) {
        return send(res, 200, { projects: workspaceProjects })
      }
      if (req.method === 'POST' && /^\/api\/internal\/workspaces\/[^/]+\/projects$/.test(path)) {
        createdProjectSeq += 1
        const id = `proj-created-${createdProjectSeq}`
        return send(res, 201, {
          project: { id, name: body?.name ?? 'New', description: body?.description ?? null, workingMode: 'managed', settings: null },
        })
      }
      const attach = /^\/api\/internal\/projects\/([^/]+)\/attachments$/.exec(path)
      if (req.method === 'POST' && attach) {
        const anchorId = decodeURIComponent(attach[1])
        if (unauthorizedAnchors.has(anchorId)) {
          // Exactly what a clean workspace apply got six times.
          return send(res, 401, { error: 'Unauthorized' })
        }
        return send(res, 201, {
          attachment: {
            id: `att-${anchorId}-${body?.attachedProjectId}`,
            attachedProjectId: body?.attachedProjectId,
            attachedProjectName: 'Target',
            attachMode: body?.attachMode ?? 'readwrite',
          },
          mounted: true,
        })
      }
      const config = /^\/api\/internal\/projects\/([^/]+)\/config$/.exec(path)
      if (config) {
        const projectId = decodeURIComponent(config[1])
        const known = graph.find((p) => p.id === projectId) ?? workspaceProjects.find((p) => p.id === projectId) ?? null
        return send(res, 200, {
          project: {
            id: projectId,
            name: known?.name ?? 'Project',
            description: known?.description ?? null,
            settings: null,
            slackEnabled: false,
            agent: null,
          },
        })
      }
      return send(res, 404, { error: `no_route ${req.method} ${path}` })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as { port: number }).port

  setEnv('SHOGO_API_URL', `http://127.0.0.1:${port}`)
  setEnv('RUNTIME_AUTH_SECRET', 'sho-63-test-runtime-token')
  // The workspace agent: a workspace runtime with no anchor project.
  setEnv('WORKSPACE_RUNTIME', 'true')
  setEnv('WORKSPACE_ANCHOR_PROJECT_ID', undefined)
})

afterAll(async () => {
  restoreEnv()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const { createSystemApplyTool } = await import('../packages/agent-runtime/src/project-tools')
type ToolContext = import('../packages/agent-runtime/src/gateway-tools').ToolContext

const WORKSPACE_ANCHOR_ID = 'ws:ws-1'

let workspaceDir = ''

function ctx(): ToolContext {
  return {
    workspaceDir,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: WORKSPACE_ANCHOR_ID,
    workspaceId: 'ws-1',
  } as ToolContext
}

async function apply(params: Record<string, any>) {
  const tool = createSystemApplyTool(ctx())
  const result = await tool.execute('call-1', params)
  return result.details as any
}

function lock(bindings: Record<string, string>, name = 'sho-63') {
  mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
  writeFileSync(join(workspaceDir, '.shogo/system.lock.json'), JSON.stringify({ version: 1, name, bindings }))
}

function node(id: string, name: string, over: Record<string, unknown> = {}) {
  return { id, name, description: null, workingMode: 'managed', settings: null, attachments: [], agent: null, ...over }
}

beforeEach(() => {
  hits.length = 0
  graph = []
  workspaceProjects = []
  unauthorizedAnchors.clear()
  createdProjectSeq = 0
  workspaceDir = mkdtempSync(join(tmpdir(), 'sho63-apply-'))
})

const CROSS_PROJECT_MANIFEST = `version: 1
name: sho-63
projects:
  - key: intake
    name: Intake
    files:
      AGENTS.md: |
        You triage incoming issues.
    attachments:
      - { project: planner, mode: readwrite }
  - key: planner
    name: Planner
`

describe('system_apply as the workspace agent', () => {
  test('a call from the workspace anchor is never attempted, and the declared project-to-project attach still runs', async () => {
    lock({ intake: 'proj-intake', planner: 'proj-planner' })
    graph = [node('proj-intake', 'Intake'), node('proj-planner', 'Planner')]
    // The exact failure the card reports: an attach *from* the workspace anchor
    // has no project identity, so the API answers 401 for every project.
    unauthorizedAnchors.add(WORKSPACE_ANCHOR_ID)

    // Unmounted on purpose: the file writes are a separate promise (below).
    const out = await apply({ manifest: CROSS_PROJECT_MANIFEST })

    expect(out.ok).toBe(true)
    expect(out.errors).toEqual([])
    expect(out.plan.join('\n')).not.toContain('attach (caller)')

    const attaches = hits.filter((h) => h.method === 'POST' && h.path.endsWith('/attachments'))
    expect(attaches.map((h) => h.path)).toEqual(['/api/internal/projects/proj-intake/attachments'])
    expect(attaches[0].body).toEqual({ attachedProjectId: 'proj-planner', attachMode: 'readwrite' })
    expect(out.applied).toContain('attach intake → planner [readwrite] (mounted)')

    expect(out.warnings).toContain('attach: skipped for the workspace agent — no project identity to attach')
    // One warning line, not one error per manifest project.
    expect(out.warnings.filter((w: string) => w.startsWith('attach:'))).toHaveLength(1)
  })
})

describe('locked ids the graph does not show', () => {
  test('a project the workspace knows but this runtime cannot see is a configure, never a duplicate create', async () => {
    lock({ intake: 'proj-intake' })
    graph = []
    workspaceProjects = [node('proj-intake', 'Intake')]
    const manifest = `version: 1
name: sho-63
projects:
  - key: intake
    name: Intake
    description: Triage incoming issues.
`

    const out = await apply({ manifest })

    expect(hits.some((h) => h.method === 'GET' && h.path === '/api/internal/workspaces/ws-1/projects')).toBe(true)
    expect(hits.some((h) => h.method === 'POST' && h.path === '/api/internal/workspaces/ws-1/projects')).toBe(false)
    expect(out.plan.join('\n')).not.toContain('not_accessible')
    expect(out.applied).toContain('configure intake')
    expect(out.bindings.intake).toBe('proj-intake')
    expect(out.ok).toBe(true)
  })

  test('a locked id nobody can see stays inaccessible and creates nothing', async () => {
    lock({ intake: 'proj-gone' })
    graph = []
    workspaceProjects = [node('proj-other', 'Other')]
    const manifest = `version: 1
name: sho-63
projects:
  - key: intake
    name: Intake
`

    const out = await apply({ manifest })

    expect(out.ok).toBe(false)
    expect(out.errors.join('\n')).toContain('not_accessible')
    expect(out.errors.join('\n')).toContain('proj-gone')
    expect(hits.some((h) => h.method === 'POST' && h.path === '/api/internal/workspaces/ws-1/projects')).toBe(false)
    expect(JSON.parse(readFileSync(join(workspaceDir, '.shogo/system.lock.json'), 'utf-8')).bindings.intake).toBe('proj-gone')
  })
})

describe('a project whose folder is not on this disk', () => {
  test('its file is skipped with a warning, never claimed as a create, and the apply is still ok', async () => {
    lock({ intake: 'proj-intake' })
    graph = [node('proj-intake', 'Intake')]
    const manifest = `version: 1
name: sho-63
projects:
  - key: intake
    name: Intake
    files:
      AGENTS.md: |
        You triage incoming issues.
`

    const out = await apply({ manifest })

    const warning = 'files intake/AGENTS.md: skipped — project not mounted in this runtime; re-run after it mounts'
    expect(out.warnings).toContain(warning)
    expect(out.plan).toContain(warning)
    expect(out.plan.some((l: string) => l.startsWith('create intake/'))).toBe(false)
    expect(out.applied.some((l: string) => l.includes('intake/AGENTS.md'))).toBe(false)
    expect(out.errors).toEqual([])
    expect(out.ok).toBe(true)
    expect(existsSync(join(workspaceDir, 'proj-intake/AGENTS.md'))).toBe(false)
  })
})

describe('a manifest that is already fully mounted', () => {
  test('the second apply reports an empty diff', async () => {
    lock({ intake: 'proj-intake', planner: 'proj-planner' })
    graph = [
      node('proj-intake', 'Intake', {
        attachments: [{ attachedProjectId: 'proj-planner', attachMode: 'readwrite' }],
      }),
      node('proj-planner', 'Planner'),
    ]
    mkdirSync(join(workspaceDir, 'proj-intake'), { recursive: true })
    mkdirSync(join(workspaceDir, 'proj-planner'), { recursive: true })
    writeFileSync(join(workspaceDir, 'proj-intake/AGENTS.md'), 'You triage incoming issues.\n')

    const out = await apply({ manifest: CROSS_PROJECT_MANIFEST })

    expect(out.errors).toEqual([])
    // Only the standing workspace-agent note — nothing is left to do.
    expect(out.warnings).toEqual(['attach: skipped for the workspace agent — no project identity to attach'])
    expect(out.plan).toEqual([])
    expect(out.applied).toEqual([])
    expect(out.empty).toBe(true)
  })
})
