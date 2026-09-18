// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the `project_*` / `system_apply` agent tools
 * (project-tools.ts). The internal-api HTTP wrappers are faked so no network
 * call happens; disk I/O uses a real temp directory so file/lock behavior is
 * exercised for real.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as realInternalApi from '../internal-api'

// ─── internal-api fakes ─────────────────────────────────────────────────

type Call = { fn: string; args: unknown[] }
const calls: Call[] = []

const api = {
  graph: { ok: true, status: 200, data: [] as any[] } as any,
  create: { ok: true, status: 201, data: { id: 'proj-new', name: 'New', description: null, workingMode: 'managed', settings: null } } as any,
  attach: { ok: true, status: 201, data: { attachment: { id: 'att-1', attachedProjectId: 'target', attachedProjectName: 'Target', attachMode: 'readwrite' }, mounted: true } } as any,
  detach: { ok: true, status: 200, data: { removed: true } } as any,
  getConfig: { ok: true, status: 200, data: { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null } } as any,
  configure: { ok: true, status: 200, data: { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null } } as any,
  call: { ok: true, status: 200, data: { status: 'completed', reply: 'done', sessionId: 'run:abc' } } as any,
}

mock.module('../internal-api', () => ({
  ...realInternalApi,
  getWorkspaceProjectGraph: (workspaceId: string) => {
    calls.push({ fn: 'getWorkspaceProjectGraph', args: [workspaceId] })
    return api.graph
  },
  createProject: (workspaceId: string, req: any) => {
    calls.push({ fn: 'createProject', args: [workspaceId, req] })
    return api.create
  },
  attachProject: (anchorId: string, targetId: string, mode: string) => {
    calls.push({ fn: 'attachProject', args: [anchorId, targetId, mode] })
    return api.attach
  },
  detachProject: (anchorId: string, targetId: string) => {
    calls.push({ fn: 'detachProject', args: [anchorId, targetId] })
    return api.detach
  },
  getProjectConfig: (projectId: string) => {
    calls.push({ fn: 'getProjectConfig', args: [projectId] })
    return api.getConfig
  },
  configureProject: (projectId: string, patch: any) => {
    calls.push({ fn: 'configureProject', args: [projectId, patch] })
    return api.configure
  },
  callProjectAgent: (targetId: string, req: any) => {
    calls.push({ fn: 'callProjectAgent', args: [targetId, req] })
    return api.call
  },
}))

const {
  createProjectListTool,
  createProjectCreateTool,
  createProjectAttachTool,
  createProjectDetachTool,
  createProjectConfigureTool,
  createProjectCallTool,
  createSystemApplyTool,
  resolveProjectDir,
} = await import('../project-tools')
type ToolContext = import('../gateway-tools').ToolContext

// ─── Test harness ──────────────────────────────────────────────────────

let workspaceDir = ''

function baseCtx(over: Partial<ToolContext> = {}): ToolContext {
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
    projectId: 'caller-1',
    workspaceId: 'ws-1',
    ...over,
  } as ToolContext
}

async function run(tool: { execute: (id: string, params: any) => Promise<any> }, params: Record<string, any> = {}) {
  const r = await tool.execute('cid', params)
  return r.details as any
}

beforeEach(() => {
  calls.length = 0
  workspaceDir = mkdtempSync(join(tmpdir(), 'project-tools-test-'))
  api.graph = { ok: true, status: 200, data: [] }
  api.create = { ok: true, status: 201, data: { id: 'proj-new', name: 'New', description: null, workingMode: 'managed', settings: null } }
  api.attach = { ok: true, status: 201, data: { attachment: { id: 'att-1', attachedProjectId: 'target', attachedProjectName: 'Target', attachMode: 'readwrite' }, mounted: true } }
  api.detach = { ok: true, status: 200, data: { removed: true } }
  api.getConfig = { ok: true, status: 200, data: { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null } }
  api.configure = { ok: true, status: 200, data: { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null } }
  api.call = { ok: true, status: 200, data: { status: 'completed', reply: 'done', sessionId: 'run:abc' } }
})

// ─── project_list ─────────────────────────────────────────────────────────

describe('project_list', () => {
  test('errors with no_workspace when the context has no workspace', async () => {
    const ctx = baseCtx({ workspaceId: undefined })
    const out = await run(createProjectListTool(ctx))
    expect(out.code).toBe('no_workspace')
  })

  test('lists projects, flags the current one, and resolves manifest keys from the lock', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo/system.lock.json'), JSON.stringify({ version: 1, name: 'sys', bindings: { worker: 'proj-2' } }))
    const ctx = baseCtx()
    const out = await run(createProjectListTool(ctx))
    expect(out.currentProjectId).toBe('caller-1')
    const worker = out.projects.find((p: any) => p.id === 'proj-2')
    expect(worker.manifestKey).toBe('worker')
    const caller = out.projects.find((p: any) => p.id === 'caller-1')
    expect(caller.isCurrent).toBe(true)
    expect(caller.onDisk).toBe(true) // resolveProjectDir(ctx, ctx.projectId) === ctx.workspaceDir
  })
})

// ─── project_create ─────────────────────────────────────────────────────────

describe('project_create', () => {
  test('creates and attaches by default, reporting mounted + projectDir', async () => {
    api.attach.data.attachment.attachedProjectId = 'proj-new'
    mkdirSync(join(workspaceDir, 'proj-new'), { recursive: true }) // simulate a mounted sibling dir
    const ctx = baseCtx()
    const out = await run(createProjectCreateTool(ctx), { name: 'New Project', techStackId: 'react-app' })
    expect(out.ok).toBe(true)
    expect(out.project.id).toBe('proj-new')
    expect(out.mounted).toBe(true)
    expect(calls.find((c) => c.fn === 'createProject')?.args[1]).toMatchObject({ name: 'New Project', techStackId: 'react-app' })
    expect(calls.find((c) => c.fn === 'attachProject')?.args).toEqual(['caller-1', 'proj-new', 'readwrite'])
  })

  test('skips attach when attach:false', async () => {
    const ctx = baseCtx()
    const out = await run(createProjectCreateTool(ctx), { name: 'New Project', attach: false })
    expect(out.attachment).toBeNull()
    expect(calls.find((c) => c.fn === 'attachProject')).toBeUndefined()
  })

  test('surfaces a lifecycle error from createProject without attaching', async () => {
    api.create = { ok: false, status: 402, error: 'This stack requires a bigger instance', code: 'instance_too_small' }
    const ctx = baseCtx()
    const out = await run(createProjectCreateTool(ctx), { name: 'Docker Project', techStackId: 'docker-compose' })
    expect(out.code).toBe('instance_too_small')
    expect(calls.find((c) => c.fn === 'attachProject')).toBeUndefined()
  })

  test('reports attach failure inline without failing the whole call', async () => {
    api.attach = { ok: false, status: 409, error: 'conflict', code: 'cross_workspace' }
    const ctx = baseCtx()
    const out = await run(createProjectCreateTool(ctx), { name: 'New Project' })
    expect(out.ok).toBe(true)
    expect(out.attachment).toMatchObject({ code: 'cross_workspace' })
    expect(out.mounted).toBe(false)
  })
})

// ─── project_attach / project_detach ────────────────────────────────────────

describe('project_attach', () => {
  test('refuses to attach a project to itself', async () => {
    api.graph.data = [{ id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null }]
    const ctx = baseCtx()
    const out = await run(createProjectAttachTool(ctx), { project: 'caller-1' })
    expect(out.code).toBe('self_attach')
    expect(calls.find((c) => c.fn === 'attachProject')).toBeUndefined()
  })

  test('resolves a project by exact name and attaches with the requested mode', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    const ctx = baseCtx()
    const out = await run(createProjectAttachTool(ctx), { project: 'Worker', mode: 'readonly' })
    expect(out.ok).toBe(true)
    expect(calls.find((c) => c.fn === 'attachProject')?.args).toEqual(['caller-1', 'proj-2', 'readonly'])
  })

  test('errors with ambiguous when two projects share a name', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-3', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    const ctx = baseCtx()
    const out = await run(createProjectAttachTool(ctx), { project: 'Worker' })
    expect(out.code).toBe('ambiguous')
  })

  test('errors with not_found for an unknown reference', async () => {
    api.graph.data = [{ id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null }]
    const ctx = baseCtx()
    const out = await run(createProjectAttachTool(ctx), { project: 'ghost' })
    expect(out.code).toBe('not_found')
  })
})

describe('project_detach', () => {
  test('detaches by id and reports removed', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    const ctx = baseCtx()
    const out = await run(createProjectDetachTool(ctx), { project: 'proj-2' })
    expect(out.ok).toBe(true)
    expect(out.removed).toBe(true)
    expect(calls.find((c) => c.fn === 'detachProject')?.args).toEqual(['caller-1', 'proj-2'])
  })
})

// ─── project_configure ───────────────────────────────────────────────────────

describe('project_configure', () => {
  test('reads the current config when no changes are given (does not call configureProject)', async () => {
    const ctx = baseCtx({ projectId: 'proj-1' })
    const out = await run(createProjectConfigureTool(ctx))
    expect(out.changed).toBe(false)
    expect(calls.find((c) => c.fn === 'getProjectConfig')).toBeDefined()
    expect(calls.find((c) => c.fn === 'configureProject')).toBeUndefined()
  })

  test('rejects a heartbeatInterval below the 60s floor before calling the API', async () => {
    const ctx = baseCtx({ projectId: 'proj-1' })
    const out = await run(createProjectConfigureTool(ctx), { heartbeatInterval: 30 })
    expect(out.error).toMatch(/at least 60/)
    expect(calls.find((c) => c.fn === 'configureProject')).toBeUndefined()
  })

  test('forwards a model + heartbeat patch to configureProject for the current project by default', async () => {
    const ctx = baseCtx({ projectId: 'proj-1' })
    const out = await run(createProjectConfigureTool(ctx), { model: 'claude-haiku-4-5', heartbeatEnabled: true, heartbeatInterval: 900 })
    expect(out.changed).toBe(true)
    expect(calls.find((c) => c.fn === 'configureProject')?.args).toEqual([
      'proj-1',
      { agent: { modelName: 'claude-haiku-4-5', heartbeatEnabled: true, heartbeatInterval: 900 } },
    ])
  })

  test('targets another project by manifest key resolved through the lock', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo/system.lock.json'), JSON.stringify({ version: 1, name: 'sys', bindings: { worker: 'proj-2' } }))
    const ctx = baseCtx()
    const out = await run(createProjectConfigureTool(ctx), { project: 'worker', name: 'Renamed Worker' })
    expect(calls.find((c) => c.fn === 'configureProject')?.args[0]).toBe('proj-2')
  })
})

// ─── project_call ────────────────────────────────────────────────────────────

describe('project_call', () => {
  test('refuses to call the current project (use agent_spawn instead)', async () => {
    api.graph.data = [{ id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null }]
    const ctx = baseCtx()
    const out = await run(createProjectCallTool(ctx), { project: 'caller-1', message: 'hi' })
    expect(out.code).toBe('self_call')
  })

  test('mints a runId when none is given and threads it through the API call', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    const ctx = baseCtx()
    const out = await run(createProjectCallTool(ctx), { project: 'proj-2', message: 'do the thing' })
    expect(out.ok).toBe(true)
    expect(out.runId).toMatch(/^run_[0-9a-f]{12}$/)
    const callArgs = calls.find((c) => c.fn === 'callProjectAgent')?.args as any[]
    expect(callArgs[0]).toBe('proj-2')
    expect(callArgs[1].runId).toBe(out.runId)
    expect(callArgs[1].callerProjectId).toBe('caller-1')
  })

  test('reuses a caller-supplied runId', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    const ctx = baseCtx()
    const out = await run(createProjectCallTool(ctx), { project: 'proj-2', message: 'hi', runId: 'run_fixed' })
    expect(out.runId).toBe('run_fixed')
  })

  test('adds a hint when the call times out', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    api.call = { ok: false, status: 504, error: 'timed out', code: 'agent_call_timeout' }
    const ctx = baseCtx()
    const out = await run(createProjectCallTool(ctx), { project: 'proj-2', message: 'hi' })
    expect(out.code).toBe('agent_call_timeout')
    expect(out.hint).toMatch(/wait=false/)
  })
})

// ─── system_apply ────────────────────────────────────────────────────────────

const MANIFEST_YAML = `
version: 1
name: issue-pipeline
projects:
  - key: intake
    name: Intake
    files:
      AGENTS.md: "You triage incoming issues."
`

describe('system_apply', () => {
  test('errors when no manifest file exists and none is given inline', async () => {
    const ctx = baseCtx()
    const out = await run(createSystemApplyTool(ctx), {})
    expect(out.code).toBe('manifest_missing')
  })

  test('rejects an unsafe manifestPath before touching disk', async () => {
    const ctx = baseCtx()
    const out = await run(createSystemApplyTool(ctx), { manifestPath: '../escape.yaml' })
    expect(out.error).toMatch(/Unsafe manifestPath/)
  })

  test('dry run reports the plan and bindings without creating anything', async () => {
    const ctx = baseCtx()
    const out = await run(createSystemApplyTool(ctx), { manifest: MANIFEST_YAML, dryRun: true })
    expect(out.dryRun).toBe(true)
    expect(out.plan.some((l: string) => l.includes('create intake'))).toBe(true)
    expect(calls.find((c) => c.fn === 'createProject')).toBeUndefined()
    // Inline manifest is not persisted on a dry run.
    expect(existsSync(join(workspaceDir, 'shogo-system.yaml'))).toBe(false)
  })

  test('apply creates the project, persists the inline manifest, writes the lock, and reports errors are empty', async () => {
    api.create = { ok: true, status: 201, data: { id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null } }
    const ctx = baseCtx()
    const out = await run(createSystemApplyTool(ctx), { manifest: MANIFEST_YAML })
    expect(out.ok).toBe(true)
    expect(out.applied.some((l: string) => l.includes('create intake'))).toBe(true)
    expect(out.bindings.intake).toBe('proj-intake')
    expect(existsSync(join(workspaceDir, 'shogo-system.yaml'))).toBe(true)
    const lock = JSON.parse(readFileSync(join(workspaceDir, '.shogo/system.lock.json'), 'utf-8'))
    expect(lock.bindings.intake).toBe('proj-intake')
  })

  test('a second apply on an already-adopted, unchanged system reports an empty diff', async () => {
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo/system.lock.json'), JSON.stringify({ version: 1, name: 'issue-pipeline', bindings: { intake: 'proj-intake' } }))
    mkdirSync(join(workspaceDir, 'proj-intake'), { recursive: true })
    writeFileSync(join(workspaceDir, 'proj-intake/AGENTS.md'), 'You triage incoming issues.')
    api.graph.data = [
      { id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null, attachments: [{ attachedProjectId: 'caller-1', attachMode: 'readwrite' }], agent: null },
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [{ attachedProjectId: 'proj-intake', attachMode: 'readwrite' }], agent: null },
    ]
    const ctx = baseCtx()
    const out = await run(createSystemApplyTool(ctx), { manifest: MANIFEST_YAML })
    expect(out.ok).toBe(true)
    expect(out.applied).toHaveLength(0)
    expect(calls.find((c) => c.fn === 'createProject')).toBeUndefined()
    expect(calls.find((c) => c.fn === 'attachProject')).toBeUndefined()
  })

  test('skips writing files for a project not yet reachable on disk, and reports it instead of erroring', async () => {
    api.create = { ok: true, status: 201, data: { id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null } }
    const ctx = baseCtx()
    // Do not create the sibling dir for proj-intake — it "isn't mounted yet".
    const out = await run(createSystemApplyTool(ctx), { manifest: MANIFEST_YAML })
    expect(out.ok).toBe(true)
    expect(out.skipped.some((l: string) => l.includes('not reachable on disk'))).toBe(true)
  })

  test('collects per-op errors without throwing when create fails, and still reports ok:false', async () => {
    api.create = { ok: false, status: 500, error: 'boom' }
    const ctx = baseCtx()
    const out = await run(createSystemApplyTool(ctx), { manifest: MANIFEST_YAML })
    expect(out.ok).toBe(false)
    expect(out.errors.some((l: string) => l.includes('create intake'))).toBe(true)
  })
})
