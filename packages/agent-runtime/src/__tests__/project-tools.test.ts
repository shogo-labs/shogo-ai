// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the `project_*` / `system_apply` agent tools
 * (project-tools.ts). The internal-api HTTP wrappers are faked so no network
 * call happens; disk I/O uses a real temp directory so file/lock behavior is
 * exercised for real.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runChatSessionId } from '@shogo/shared-runtime/project-call-chat'
import * as realInternalApi from '../internal-api'
import { setTechStackPreviewRestarter, type PreviewRestartRequest } from '../tech-stack-switch'

// ─── internal-api fakes ─────────────────────────────────────────────────

type Call = { fn: string; args: unknown[] }
const calls: Call[] = []
let internalApiCredentials = false

const api = {
  graph: { ok: true, status: 200, data: [] as any[] } as any,
  create: { ok: true, status: 201, data: { id: 'proj-new', name: 'New', description: null, workingMode: 'managed', settings: null } } as any,
  attach: { ok: true, status: 201, data: { attachment: { id: 'att-1', attachedProjectId: 'target', attachedProjectName: 'Target', attachMode: 'readwrite' }, mounted: true } } as any,
  detach: { ok: true, status: 200, data: { removed: true } } as any,
  getConfig: { ok: true, status: 200, data: { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null } } as any,
  configure: { ok: true, status: 200, data: { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null } } as any,
  workspaceConfig: { ok: true, status: 200, data: { id: 'ws-1', name: 'WS', kind: 'team', settings: {} } } as any,
  call: { ok: true, status: 200, data: { status: 'completed', reply: 'done', sessionId: 'run:abc' } } as any,
  teamChannels: { ok: true, status: 200, data: { channels: [], groups: {} } } as any,
  workspaceProjects: { ok: true, status: 200, data: [] as any[] } as any,
  upsertChannel: { ok: true, status: 201, data: { created: true, changes: ['created'], channel: { id: 'conv-1', name: 'ops' } } } as any,
  ownership: { ok: true, status: 200, data: { claimed: [], released: [] } } as any,
  boards: { ok: true, status: 200, data: { boards: [] } } as any,
  triggers: { ok: true, status: 200, data: [] } as any,
}

mock.module('../internal-api', () => ({
  ...realInternalApi,
  hasInternalApiCredentials: () => internalApiCredentials,
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
  configureWorkspace: (workspaceId: string, patch: any) => {
    calls.push({ fn: 'configureWorkspace', args: [workspaceId, patch] })
    return api.workspaceConfig
  },
  getWorkspaceConfig: (workspaceId: string) => {
    calls.push({ fn: 'getWorkspaceConfig', args: [workspaceId] })
    return api.workspaceConfig
  },
  callProjectAgent: (targetId: string, req: any) => {
    calls.push({ fn: 'callProjectAgent', args: [targetId, req] })
    return api.call
  },
  listTeamChannels: (workspaceId: string) => {
    calls.push({ fn: 'listTeamChannels', args: [workspaceId] })
    return api.teamChannels
  },
  listWorkspaceProjects: (workspaceId: string, opts: unknown) => {
    calls.push({ fn: 'listWorkspaceProjects', args: [workspaceId, opts] })
    return api.workspaceProjects
  },
  upsertTeamChannel: (workspaceId: string, name: string, input: any) => {
    calls.push({ fn: 'upsertTeamChannel', args: [workspaceId, name, input] })
    return api.upsertChannel
  },
  syncTeamChannelOwnership: (workspaceId: string, system: string, declared: string[]) => {
    calls.push({ fn: 'syncTeamChannelOwnership', args: [workspaceId, system, declared] })
    return api.ownership
  },
  agentBoardsRequest: (workspaceId: string, method: string, path: string, options: any) => {
    calls.push({ fn: 'agentBoardsRequest', args: [workspaceId, method, path, options] })
    return method === 'GET' ? api.boards : { ok: true, status: 201, data: {} }
  },
  listTriggers: (workspaceId: string) => {
    calls.push({ fn: 'listTriggers', args: [workspaceId] })
    return api.triggers
  },
  createTrigger: (workspaceId: string, input: any) => {
    calls.push({ fn: 'createTrigger', args: [workspaceId, input] })
    return { ok: true, status: 201, data: { trigger: { id: 'trig-1' } } }
  },
  updateTrigger: (workspaceId: string, id: string, input: any) => {
    calls.push({ fn: 'updateTrigger', args: [workspaceId, id, input] })
    return { ok: true, status: 200, data: { trigger: { id } } }
  },
  deleteTrigger: (workspaceId: string, id: string, userId: string) => {
    calls.push({ fn: 'deleteTrigger', args: [workspaceId, id, userId] })
    return { ok: true, status: 200, data: { ok: true } }
  },
}))

const {
  createProjectListTool,
  createProjectCreateTool,
  createProjectAttachTool,
  createProjectDetachTool,
  createProjectConfigureTool,
  createCapabilitiesConfigureTool,
  createProjectCallTool,
  createSystemApplyTool,
  createListModelsTool,
  resolveProjectDir,
} = await import('../project-tools')
const { __resetAvailableModelsForTests } = await import('../available-models')
type ToolContext = import('../gateway-tools').ToolContext

// ─── Test harness ──────────────────────────────────────────────────────

let workspaceDir = ''
/** Preview restarts requested by a stack switch (a stub stands in for server.ts). */
let restarts: PreviewRestartRequest[] = []

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
  internalApiCredentials = false
  workspaceDir = mkdtempSync(join(tmpdir(), 'project-tools-test-'))
  restarts = []
  setTechStackPreviewRestarter((req) => void restarts.push(req))
  api.graph = { ok: true, status: 200, data: [] }
  api.create = { ok: true, status: 201, data: { id: 'proj-new', name: 'New', description: null, workingMode: 'managed', settings: null } }
  api.attach = { ok: true, status: 201, data: { attachment: { id: 'att-1', attachedProjectId: 'target', attachedProjectName: 'Target', attachMode: 'readwrite' }, mounted: true } }
  api.detach = { ok: true, status: 200, data: { removed: true } }
  api.getConfig = { ok: true, status: 200, data: { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null } }
  api.configure = { ok: true, status: 200, data: { id: 'proj-1', name: 'Proj', description: null, settings: null, slackEnabled: false, agent: null } }
  api.workspaceConfig = { ok: true, status: 200, data: { id: 'ws-1', name: 'WS', kind: 'team', settings: {} } }
  api.call = { ok: true, status: 200, data: { status: 'completed', reply: 'done', sessionId: 'run:abc' } }
  api.teamChannels = { ok: true, status: 200, data: { channels: [], groups: {} } }
  api.workspaceProjects = { ok: true, status: 200, data: [] }
  api.upsertChannel = { ok: true, status: 201, data: { created: true, changes: ['created'], channel: { id: 'conv-1', name: 'ops' } } }
  api.ownership = { ok: true, status: 200, data: { claimed: [], released: [] } }
  api.boards = { ok: true, status: 200, data: { boards: [] } }
  api.triggers = { ok: true, status: 200, data: [] }
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
    expect(worker.techStackId).toBeNull()
    const caller = out.projects.find((p: any) => p.id === 'caller-1')
    expect(caller.isCurrent).toBe(true)
    expect(caller.onDisk).toBe(true) // resolveProjectDir(ctx, ctx.projectId) === ctx.workspaceDir
  })

  test('includes each project\'s tech stack id', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: { techStackId: 'video-editor' }, attachments: [], agent: null },
    ]
    const out = await run(createProjectListTool(baseCtx()))
    expect(out.projects[0].techStackId).toBe('video-editor')
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

  test('describes every project type the runtime ships (id, name, description)', async () => {
    const tool = createProjectCreateTool(baseCtx())
    for (const id of ['react-app', 'expo-app', 'python-data', 'video-editor', 'custom', 'none']) {
      expect(tool.description).toContain(`"${id}"`)
    }
    expect(tool.description).toContain('Video Editor')
    // The param description carries the ids too, so the model can pick blind.
    const param = (tool.parameters as any).properties.techStackId
    expect(param.description).toContain('video-editor')
  })

  test('fails an unknown techStackId with the valid ids instead of copying the Vite template', async () => {
    const ctx = baseCtx()
    const out = await run(createProjectCreateTool(ctx), { name: 'Mystery', techStackId: 'video-editr' })
    expect(out.code).toBe('unknown_tech_stack')
    expect(out.validTechStackIds).toContain('video-editor')
    expect(out.validTechStackIds).toContain('react-app')
    expect(calls.find((c) => c.fn === 'createProject')).toBeUndefined()
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

// ─── list_models ─────────────────────────────────────────────────────────────

describe('list_models', () => {
  const realFetch = globalThis.fetch
  const savedProxy = { url: process.env.AI_PROXY_URL, token: process.env.AI_PROXY_TOKEN }
  const LIST = {
    object: 'list',
    data: [
      { id: 'claude-opus-5-5', owned_by: 'anthropic', display_name: 'Claude Opus 5.5', available: true },
      { id: 'claude-opus-5', owned_by: 'anthropic', display_name: 'Claude Opus 5', available: true },
      { id: 'gpt-6-luna', owned_by: 'openai', display_name: 'GPT-6 Luna', available: true },
      { id: 'gpt-live-1', owned_by: 'openai', display_name: 'GPT-Live 1', kind: 'live', available: true },
    ],
  }

  beforeEach(() => {
    __resetAvailableModelsForTests()
    process.env.AI_PROXY_URL = 'https://api.example.test/api/ai/v1'
    process.env.AI_PROXY_TOKEN = 'proxy-token'
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    if (savedProxy.url === undefined) delete process.env.AI_PROXY_URL
    else process.env.AI_PROXY_URL = savedProxy.url
    if (savedProxy.token === undefined) delete process.env.AI_PROXY_TOKEN
    else process.env.AI_PROXY_TOKEN = savedProxy.token
    __resetAvailableModelsForTests()
  })

  function mockModels(payload: unknown, status = 200) {
    let count = 0
    globalThis.fetch = (async () => {
      count++
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    }) as any
    return () => count
  }

  test('returns every usable chat model with id, display name and provider', async () => {
    mockModels(LIST)
    const out = await run(createListModelsTool())
    expect(out.default).toBe('auto')
    expect(out.models).toEqual([
      { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', provider: 'anthropic' },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', provider: 'anthropic' },
      { id: 'gpt-6-luna', displayName: 'GPT-6 Luna', provider: 'openai' },
    ])
  })

  test('filters by a picker-style name', async () => {
    mockModels(LIST)
    const out = await run(createListModelsTool(), { query: 'Opus 5.5' })
    expect(out.models.map((m: any) => m.id)).toEqual(['claude-opus-5-5'])
  })

  test('refetches on every call instead of using the cache', async () => {
    const count = mockModels(LIST)
    await run(createListModelsTool())
    await run(createListModelsTool())
    expect(count()).toBe(2)
  })

  test('errors when the list cannot be loaded', async () => {
    mockModels({ error: 'boom' }, 500)
    const out = await run(createListModelsTool())
    expect(out.code).toBe('models_unavailable')
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

  test('reports a paywall heartbeatError as a warning while the rest of the patch applies', async () => {
    api.configure = {
      ok: true,
      status: 200,
      data: {
        id: 'proj-1', name: 'Renamed', description: null, settings: null, slackEnabled: false, agent: null,
        heartbeatError: { code: 'paywall', message: 'Heartbeats require a paid plan.' },
      },
    }
    const ctx = baseCtx({ projectId: 'proj-1' })
    const out = await run(createProjectConfigureTool(ctx), { name: 'Renamed', heartbeatEnabled: true })
    expect(out.ok).toBe(true)
    expect(out.changed).toBe(true)
    expect(out.project.name).toBe('Renamed')
    expect(out.heartbeatError).toMatchObject({ code: 'paywall' })
    expect(out.warning).toContain('Heartbeat settings were not applied')
  })

  test('has no warning when the heartbeat part was applied', async () => {
    const ctx = baseCtx({ projectId: 'proj-1' })
    const out = await run(createProjectConfigureTool(ctx), { heartbeatEnabled: true })
    expect(out.heartbeatError).toBeUndefined()
    expect(out.warning).toBeUndefined()
  })

  test('forwards an explicit workingMode to configureProject, including on its own', async () => {
    const ctx = baseCtx({ projectId: 'proj-1' })
    const out = await run(createProjectConfigureTool(ctx), { workingMode: 'external' })
    expect(out.changed).toBe(true)
    expect(calls.find((c) => c.fn === 'configureProject')?.args).toEqual([
      'proj-1',
      { workingMode: 'external' },
    ])
  })

  test('rejects a workingMode outside managed/external before calling the API', async () => {
    const ctx = baseCtx({ projectId: 'proj-1' })
    const out = await run(createProjectConfigureTool(ctx), { workingMode: 'cloud' })
    expect(out.error).toMatch(/managed.*external|external.*managed/)
    expect(calls.find((c) => c.fn === 'configureProject')).toBeUndefined()
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

  // ── project type (`techStackId` / `resetFiles`) ──────────────────────────

  test('rejects an unknown techStackId before patching anything', async () => {
    const ctx = baseCtx({ projectId: 'proj-1' })
    const out = await run(createProjectConfigureTool(ctx), { techStackId: 'nope' })
    expect(out.code).toBe('unknown_tech_stack')
    expect(out.validTechStackIds).toContain('video-editor')
    expect(calls.find((c) => c.fn === 'configureProject')).toBeUndefined()
  })

  test('is a no-op when the project is already on that stack (and still applies other fields)', async () => {
    api.getConfig.data.settings = { techStackId: 'video-editor' }
    const ctx = baseCtx({ projectId: 'proj-1' })
    const same = await run(createProjectConfigureTool(ctx), { techStackId: 'video-editor' })
    expect(same.changed).toBe(false)
    expect(same.techStackId).toBe('video-editor')
    expect(same.stackNote).toContain('Already on "video-editor"')
    expect(calls.find((c) => c.fn === 'configureProject')).toBeUndefined()

    const renamed = await run(createProjectConfigureTool(ctx), { techStackId: 'video-editor', name: 'Renamed' })
    expect(renamed.changed).toBe(true)
    expect(calls.find((c) => c.fn === 'configureProject')?.args).toEqual(['proj-1', { name: 'Renamed' }])
  })

  test('switches the stack: patches settings + the stack capabilities, seeds the files, restarts once', async () => {
    api.getConfig.data.settings = { techStackId: 'react-app' }
    api.configure.data.settings = { techStackId: 'video-editor' }
    const ctx = baseCtx({ projectId: 'proj-1' })

    const out = await run(createProjectConfigureTool(ctx), { techStackId: 'video-editor' })

    const patch = calls.find((c) => c.fn === 'configureProject')?.args[1] as any
    expect(patch.settings.techStackId).toBe('video-editor')
    // Stack capabilities ride along in the same PATCH.
    expect(patch.settings.videoGenEnabled).toBe(true)
    expect(patch.settings.browserEnabled).toBe(true)

    expect(out.stack).toMatchObject({
      from: 'react-app',
      to: 'video-editor',
      applied: 'local',
      seeded: true,
      collisions: [],
      leftInPlace: [],
      stackDocUpdated: true,
    })
    expect(out.stack.previewRestarted).toBe(true)
    expect(restarts).toHaveLength(1)
    expect(restarts[0]).toMatchObject({ projectId: 'proj-1', stackId: 'video-editor' })
    // Seeded into the mounted project folder.
    expect(existsSync(join(workspaceDir, '.tech-stack'))).toBe(true)
    expect(readFileSync(join(workspaceDir, '.tech-stack'), 'utf-8').trim()).toBe('video-editor')
    expect(existsSync(join(workspaceDir, 'remotion.config.ts'))).toBe(true)
  })

  test('a colliding switch is refused, patches nothing and writes nothing', async () => {
    api.getConfig.data.settings = { techStackId: 'react-app' }
    api.configure.data.settings = { techStackId: 'video-editor' }
    const ctx = baseCtx({ projectId: 'proj-1' })
    await run(createProjectConfigureTool(ctx), { techStackId: 'video-editor' })
    const patchesAfterSeed = calls.filter((c) => c.fn === 'configureProject').length

    api.getConfig.data.settings = { techStackId: 'video-editor' }
    api.configure.data.settings = { techStackId: 'react-app' }
    // The other field in the same call must not apply either.
    const out = await run(createProjectConfigureTool(ctx), { techStackId: 'react-app', name: 'Should not apply' })

    expect(out.ok).toBe(false)
    expect(out.code).toBe('stack_change_needs_reset')
    expect(out.collisions).toContain('package.json')
    expect(out.collisions).toContain('index.html')
    expect(out.collisions).toContain('src')
    expect(out.hint).toContain('resetFiles: true')
    expect(out.error).toContain('Nothing was changed')
    // No PATCH at all — not the stack, not the name.
    expect(calls.filter((c) => c.fn === 'configureProject')).toHaveLength(patchesAfterSeed)
    // And the folder is as the previous stack left it.
    expect(readFileSync(join(workspaceDir, '.tech-stack'), 'utf-8').trim()).toBe('video-editor')
    expect(readFileSync(join(workspaceDir, '.shogo', 'STACK.md'), 'utf-8')).toContain('Video Editor')
    expect(readFileSync(join(workspaceDir, 'package.json'), 'utf-8')).not.toContain('@shogo-ai/sdk')
    expect(existsSync(join(workspaceDir, 'prisma'))).toBe(false)
  })

  test('resetFiles is the way through a collision: it wipes, seeds and swaps the doc', async () => {
    api.getConfig.data.settings = { techStackId: 'react-app' }
    api.configure.data.settings = { techStackId: 'video-editor' }
    const ctx = baseCtx({ projectId: 'proj-1' })
    await run(createProjectConfigureTool(ctx), { techStackId: 'video-editor' })

    api.getConfig.data.settings = { techStackId: 'video-editor' }
    api.configure.data.settings = { techStackId: 'react-app' }
    const out = await run(createProjectConfigureTool(ctx), { techStackId: 'react-app', resetFiles: true })

    expect(out.ok).toBe(true)
    expect(out.stack.wiped).toBeGreaterThan(0)
    expect(out.stack.stackDocUpdated).toBe(true)
    expect(existsSync(join(workspaceDir, 'src', 'videos', 'Main.tsx'))).toBe(false)
    expect(readFileSync(join(workspaceDir, '.shogo', 'STACK.md'), 'utf-8')).toContain('Tech Stack — React App')
    expect(readFileSync(join(workspaceDir, '.tech-stack'), 'utf-8').trim()).toBe('react-app')
  })

  test('a switch to a stack that ships no files says so instead of nothing', async () => {
    api.getConfig.data.settings = { techStackId: 'react-app' }
    api.configure.data.settings = { techStackId: 'none' }
    const ctx = baseCtx({ projectId: 'proj-1' })

    const out = await run(createProjectConfigureTool(ctx), { techStackId: 'none' })

    expect(out.stack.collisions).toEqual([])
    expect(out.stack.leftInPlace).toEqual([])
    expect(out.stack.note).toContain('ships no files of its own')
    expect(out.stack.note).toContain('resetFiles: true')
  })

  test('reports appliesOnNextStart when the project is not mounted here', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: { techStackId: 'react-app' }, attachments: [], agent: null },
    ]
    api.getConfig.data.settings = { techStackId: 'react-app' }
    const ctx = baseCtx()

    const out = await run(createProjectConfigureTool(ctx), { project: 'proj-2', techStackId: 'video-editor' })

    expect(out.stack.applied).toBe('next-start')
    expect(out.stack.appliesOnNextStart).toBe(true)
    expect(out.stack.seeded).toBeUndefined()
    expect(restarts).toHaveLength(0)
    // Settings were still persisted.
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

  test('emits a preliminary result with the target chat before waiting for the call', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    let resolveCall!: (value: any) => void
    api.call = new Promise((resolve) => {
      resolveCall = resolve
    }) as any
    const events: any[] = []
    const pending = run(
      createProjectCallTool(baseCtx({ uiWriter: { write: (event: any) => events.push(event) } })),
      { project: 'proj-2', message: 'go', runId: 'run_fixed' },
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events[0]).toEqual({
      type: 'tool-output-available',
      toolCallId: 'cid',
      output: {
        project: { id: 'proj-2', name: 'Worker' },
        runId: 'run_fixed',
        status: 'running',
        wait: true,
        chatSessionId: runChatSessionId('proj-2', 'run_fixed'),
      },
      dynamic: true,
      preliminary: true,
    })
    expect(calls.find((call) => call.fn === 'callProjectAgent')).toBeDefined()

    resolveCall({ ok: true, status: 200, data: { status: 'completed', reply: 'done', chatSessionId: 'chat-123' } })
    await pending
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

  test('surfaces URLs from a delegated reply as deliverables', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    api.call = {
      ok: true,
      status: 200,
      data: { status: 'completed', reply: 'Preview: https://demo.shogo.one. Published: https://app.example.com/path', sessionId: 'run:abc' },
    }
    const ctx = baseCtx({ config: { ...baseCtx().config, capabilityProfile: 'personal' } as any })
    const out = await run(createProjectCallTool(ctx), { project: 'proj-2', message: 'build it' })
    expect(out.deliverables).toEqual([
      { type: 'url', label: 'Worker', href: 'https://demo.shogo.one', projectId: 'proj-2' },
      { type: 'url', label: 'Worker', href: 'https://app.example.com/path', projectId: 'proj-2' },
    ])
  })

  test('returns the chat that records the call, and the target project', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    api.call = {
      ok: true,
      status: 200,
      data: { status: 'completed', reply: 'done', sessionId: 'chat-123', chatSessionId: 'chat-123' },
    }
    const out = await run(createProjectCallTool(baseCtx()), { project: 'proj-2', message: 'go' })
    expect(out.chatSessionId).toBe('chat-123')
    expect(out.wait).toBe(true)
    expect(out.project).toEqual({ id: 'proj-2', name: 'Worker' })
  })

  test('falls back to the runtime session id and reports wait=false', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    api.call = { ok: true, status: 202, data: { status: 'accepted', sessionId: 'run:abc' } }
    const out = await run(createProjectCallTool(baseCtx()), { project: 'proj-2', message: 'go', wait: false })
    expect(out.chatSessionId).toBe('run:abc')
    expect(out.wait).toBe(false)
  })

  test('names the target project on failure', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    api.call = { ok: false, status: 502, error: 'boom', code: 'agent_call_failed' }
    const out = await run(createProjectCallTool(baseCtx()), { project: 'proj-2', message: 'go' })
    expect(out.project).toEqual({ id: 'proj-2', name: 'Worker' })
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

  test('a waiting call that produced no reply is a failure, not ok with reply:null', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    api.call = {
      ok: true,
      status: 200,
      data: {
        status: 'accepted',
        chatSessionId: 'chat-9',
        error: { code: 'callee_turn_never_started', message: 'The target agent never started this run (its chat was busy).' },
      },
    }
    const out = await run(createProjectCallTool(baseCtx()), { project: 'proj-2', message: 'go' })

    expect(out.ok).toBe(false)
    expect(out.code).toBe('callee_turn_never_started')
    expect(out.error).toContain('never started')
    expect(out.reply).toBeUndefined()
  })

  test('a waiting call with a plain 202 and no error says where to read the reply', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    api.call = { ok: true, status: 202, data: { status: 'accepted', chatSessionId: 'chat-9' } }
    const out = await run(createProjectCallTool(baseCtx()), { project: 'proj-2', message: 'go' })

    expect(out.ok).toBe(false)
    expect(out.code).toBe('call_without_reply')
    expect(out.error).toContain('chat-9')
  })

  test('a background call with no reply is still accepted', async () => {
    api.graph.data = [
      { id: 'caller-1', name: 'Caller', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
      { id: 'proj-2', name: 'Worker', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    api.call = { ok: true, status: 202, data: { status: 'accepted', sessionId: 'run:abc' } }
    const out = await run(createProjectCallTool(baseCtx()), { project: 'proj-2', message: 'go', wait: false })
    expect(out.ok).not.toBe(false)
    expect(out.wait).toBe(false)
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

  test('a lock binding the requester cannot see is not_accessible and is not recreated', async () => {
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo/system.lock.json'), JSON.stringify({
      version: 1, name: 'hidden', bindings: { secret: 'proj-hidden' },
    }))
    api.graph.data = []
    const manifest = `
version: 1
name: hidden
projects:
  - key: secret
    name: Secret
`
    const out = await run(createSystemApplyTool(baseCtx()), { manifest })
    expect(out.errors.some((l: string) => l.includes('not_accessible') && l.includes('proj-hidden'))).toBe(true)
    expect(out.plan.some((l: string) => l.startsWith('not_accessible secret'))).toBe(true)
    expect(calls.find((c) => c.fn === 'createProject')).toBeUndefined()
    const lock = JSON.parse(readFileSync(join(workspaceDir, '.shogo/system.lock.json'), 'utf-8'))
    expect(lock.bindings.secret).toBe('proj-hidden')
  })

  test('reports a heartbeat paywall as an error but still applies the rest of the configure', async () => {
    api.create = { ok: true, status: 201, data: { id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null } }
    api.configure = {
      ok: true,
      status: 200,
      data: {
        id: 'proj-intake', name: 'Intake', description: null, settings: null, slackEnabled: false, agent: null,
        heartbeatError: { code: 'paywall', message: 'Heartbeats require a paid plan.' },
      },
    }
    const manifest = `
version: 1
name: issue-pipeline
projects:
  - key: intake
    name: Intake
    agent:
      model: claude-haiku-4-5
      heartbeat:
        enabled: true
        interval: 900
`
    const out = await run(createSystemApplyTool(baseCtx()), { manifest })
    expect(out.applied.some((l: string) => l.includes('configure intake'))).toBe(true)
    expect(out.errors.some((l: string) => l.includes('heartbeat not applied') && l.includes('paid plan'))).toBe(true)
    expect(out.ok).toBe(false)
  })

  test('a project created in this apply but not reachable on disk is skipped, warns, and still reports ok:true', async () => {
    api.create = { ok: true, status: 201, data: { id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null } }
    const ctx = baseCtx()
    // Do not create the sibling dir for proj-intake — it "isn't mounted yet".
    const out = await run(createSystemApplyTool(ctx), { manifest: MANIFEST_YAML })
    expect(out.ok).toBe(true)
    expect(out.errors).toEqual([])
    expect(out.warnings).toEqual(['files intake/AGENTS.md: skipped — project not mounted in this runtime; re-run after it mounts'])
    expect(out.applied.some((l: string) => l.startsWith('create intake/'))).toBe(false)
    expect(existsSync(join(workspaceDir, 'proj-intake/AGENTS.md'))).toBe(false)
  })

  test('a bound project that is not on this disk is a skip in the plan, never a create', async () => {
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo/system.lock.json'), JSON.stringify({
      version: 1, name: 'issue-pipeline', bindings: { intake: 'proj-intake' },
    }))
    api.graph.data = [
      { id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null, attachments: [], agent: null },
    ]
    const out = await run(createSystemApplyTool(baseCtx()), { manifest: MANIFEST_YAML, dryRun: true })
    expect(out.plan).toContain('files intake/AGENTS.md: skipped — project not mounted in this runtime; re-run after it mounts')
    expect(out.plan.some((l: string) => l.startsWith('create intake/'))).toBe(false)
    expect(out.warnings).toEqual(['files intake/AGENTS.md: skipped — project not mounted in this runtime; re-run after it mounts'])
  })

  test('a lock binding the graph does not show but the workspace does is a configure, not a duplicate create', async () => {
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo/system.lock.json'), JSON.stringify({
      version: 1, name: 'issue-pipeline', bindings: { intake: 'proj-intake' },
    }))
    api.graph.data = []
    api.workspaceProjects = { ok: true, status: 200, data: [{ id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null }] }
    const manifest = `version: 1
name: issue-pipeline
projects:
  - key: intake
    name: Intake
    description: Triage incoming issues.
`
    const out = await run(createSystemApplyTool(baseCtx()), { manifest })
    expect(calls.find((c) => c.fn === 'listWorkspaceProjects')).toBeDefined()
    expect(calls.find((c) => c.fn === 'createProject')).toBeUndefined()
    expect(out.applied).toContain('configure intake')
    expect(out.plan.join('\n')).not.toContain('not_accessible')
    expect(out.bindings.intake).toBe('proj-intake')
  })

  test('a lock binding no one can see stays inaccessible and creates nothing', async () => {
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo/system.lock.json'), JSON.stringify({
      version: 1, name: 'issue-pipeline', bindings: { intake: 'proj-gone' },
    }))
    api.graph.data = []
    api.workspaceProjects = { ok: true, status: 200, data: [{ id: 'proj-other', name: 'Other', description: null, workingMode: 'managed', settings: null }] }
    const out = await run(createSystemApplyTool(baseCtx()), { manifest: MANIFEST_YAML })
    expect(calls.find((c) => c.fn === 'createProject')).toBeUndefined()
    expect(out.errors.join('\n')).toContain('not_accessible')
  })

  test('the workspace agent gets no implicit caller attach and a clean warning instead of six Unauthorized errors', async () => {
    api.create = { ok: true, status: 201, data: { id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null } }
    const prev = { runtime: process.env.WORKSPACE_RUNTIME, anchor: process.env.WORKSPACE_ANCHOR_PROJECT_ID }
    process.env.WORKSPACE_RUNTIME = 'true'
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    try {
      const out = await run(createSystemApplyTool(baseCtx()), { manifest: MANIFEST_YAML })
      expect(calls.find((c) => c.fn === 'attachProject')).toBeUndefined()
      expect(out.ok).toBe(true)
      expect(out.warnings).toContain('attach: skipped for the workspace agent — no project identity to attach')
      expect(out.plan.join('\n')).not.toContain('attach (caller)')
    } finally {
      if (prev.runtime === undefined) delete process.env.WORKSPACE_RUNTIME
      else process.env.WORKSPACE_RUNTIME = prev.runtime
      if (prev.anchor === undefined) delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
      else process.env.WORKSPACE_ANCHOR_PROJECT_ID = prev.anchor
    }
  })

  test('collects per-op errors without throwing when create fails, and still reports ok:false', async () => {
    api.create = { ok: false, status: 500, error: 'boom' }
    const ctx = baseCtx()
    const out = await run(createSystemApplyTool(ctx), { manifest: MANIFEST_YAML })
    expect(out.ok).toBe(false)
    expect(out.errors.some((l: string) => l.includes('create intake'))).toBe(true)
  })

  test('creates team channels after the projects they list, resolving new project ids', async () => {
    api.create = { ok: true, status: 201, data: { id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null } }
    const manifest = `${MANIFEST_YAML}teamChannels:
  - name: ops
    topic: Incidents
    members:
      - { project: intake, agentTrigger: all }
      - { user: lead@example.com }
`
    const ctx = baseCtx()
    const dry = await run(createSystemApplyTool(ctx), { manifest, dryRun: true })
    expect(dry.plan).toContain('create channel #ops: add agent intake (all), add lead@example.com')
    expect(calls.find((c) => c.fn === 'upsertTeamChannel')).toBeUndefined()

    const out = await run(createSystemApplyTool(ctx), { manifest })
    expect(out.ok).toBe(true)
    expect(out.applied).toContain('create channel #ops')
    const upsert = calls.find((c) => c.fn === 'upsertTeamChannel')!
    expect(upsert.args).toEqual(['ws-1', 'ops', {
      topic: 'Incidents',
      private: false,
      agents: [{ projectId: 'proj-intake', agentTrigger: 'all', agentKeywords: null, agentContextMode: 'shared' }],
      removeAgentProjectIds: [],
      userEmails: ['lead@example.com'],
      groupHandles: [],
      system: 'caller-1',
    }])
    expect(calls.findIndex((c) => c.fn === 'createProject')).toBeLessThan(calls.findIndex((c) => c.fn === 'upsertTeamChannel'))
  })

  test('protects every declared channel and releases the ones the manifest dropped', async () => {
    api.ownership = { ok: true, status: 200, data: { claimed: ['ops'], released: ['old-standup'] } }
    const manifest = `${MANIFEST_YAML}teamChannels:
  - name: ops
  - name: '#support'
`
    const ctx = baseCtx()
    await run(createSystemApplyTool(ctx), { manifest, dryRun: true })
    expect(calls.find((c) => c.fn === 'syncTeamChannelOwnership')).toBeUndefined()

    const out = await run(createSystemApplyTool(ctx), { manifest })
    expect(out.ok).toBe(true)
    const sync = calls.find((c) => c.fn === 'syncTeamChannelOwnership')!
    expect(sync.args[0]).toBe('ws-1')
    expect(sync.args[1]).toBe('caller-1')
    expect(sync.args[2]).toHaveLength(2)
    expect(out.applied).toContain('release channel #old-standup')
    expect(out.applied.some((l: string) => l.includes('#ops') && l.startsWith('release'))).toBe(false)
  })

  test('a manifest with no channels left releases everything it had declared', async () => {
    api.ownership = { ok: true, status: 200, data: { claimed: [], released: ['ops'] } }
    const out = await run(createSystemApplyTool(baseCtx()), { manifest: MANIFEST_YAML })
    expect(calls.find((c) => c.fn === 'syncTeamChannelOwnership')!.args).toEqual(['ws-1', 'caller-1', []])
    expect(out.applied).toContain('release channel #ops')
  })

  test('an API without the ownership endpoint does not fail the apply', async () => {
    api.ownership = { ok: false, status: 404, error: 'Not found' }
    const out = await run(createSystemApplyTool(baseCtx()), { manifest: MANIFEST_YAML })
    expect(out.ok).toBe(true)
    expect(out.skipped.join('\n')).toContain('channel ownership: Not found')
  })

  test('reports channels as manual steps when team chat is unreachable', async () => {
    api.teamChannels = { ok: false, status: 403, error: 'Team chat is turned off', code: 'chat_disabled' }
    const manifest = `${MANIFEST_YAML}teamChannels:
  - name: ops
`
    const out = await run(createSystemApplyTool(baseCtx()), { manifest, dryRun: true })
    expect(out.manual.join('\n')).toContain('create #ops by hand')
  })
})

describe('system_apply boards and triggers', () => {
  const manifest = `${MANIFEST_YAML}teamChannels:
  - name: support
    members:
      - { project: intake }
    boards:
      - name: Tickets
        itemType: ticket
        defaultAgent: intake
        columns:
          - { name: New, category: backlog }
          - { name: Triage, category: active, agent: intake }
          - { name: Solved, category: done }
triggers:
  - key: tickets
    name: New tickets
    event: member.joined
    target: work_item
    card: { board: Tickets, channel: support, title: "{{ticket.subject}}", dedupeKey: "{{ticket.id}}" }
`
  const adminCtx = () => baseCtx({ userId: 'user-1', config: { ...baseCtx().config, boardAdminEnabled: true } as any })

  test('creates boards with resolved agents and triggers that run as the user, then records them in the lock', async () => {
    api.create = { ok: true, status: 201, data: { id: 'proj-intake', name: 'Intake', description: null, workingMode: 'managed', settings: null } }
    const ctx = adminCtx()
    const dry = await run(createSystemApplyTool(ctx), { manifest, dryRun: true })
    expect(dry.plan).toContain('create board #support Tickets: ticket board, 3 columns')
    expect(dry.plan).toContain('create trigger tickets "New tickets"')
    expect(calls.some((c) => c.fn === 'createTrigger' || (c.fn === 'agentBoardsRequest' && c.args[1] === 'POST'))).toBe(false)

    const out = await run(createSystemApplyTool(ctx), { manifest })
    expect(out.errors).toEqual([])
    const post = calls.find((c) => c.fn === 'agentBoardsRequest' && c.args[1] === 'POST')!
    expect(post.args[2]).toBe('/agent-boards')
    expect((post.args[3] as any).body).toMatchObject({
      name: 'Tickets',
      channel: 'support',
      item_type: 'ticket',
      system: 'caller-1',
      default_agent: 'project:proj-intake',
      columns: [{ name: 'New', category: 'backlog' }, { name: 'Triage', category: 'active', agent: 'project:proj-intake' }, { name: 'Solved', category: 'done' }],
    })
    expect(calls.findIndex((c) => c.fn === 'upsertTeamChannel')).toBeLessThan(calls.findIndex((c) => c.fn === 'agentBoardsRequest' && c.args[1] === 'POST'))
    const trigger = calls.find((c) => c.fn === 'createTrigger')!
    expect(trigger.args[1]).toMatchObject({ userId: 'user-1', eventType: 'member.joined', target: 'work_item', workItemTarget: { board: 'Tickets', channel: 'support', dedupeKey: '{{ticket.id}}', mapping: { title: '{{ticket.subject}}' } } })
    const lock = JSON.parse(readFileSync(join(workspaceDir, '.shogo/system.lock.json'), 'utf-8'))
    expect(lock.triggers.tickets.id).toBe('trig-1')
    expect(lock.triggers.tickets.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  test('without board management or a person, boards and triggers are manual steps', async () => {
    const out = await run(createSystemApplyTool(baseCtx()), { manifest, dryRun: true })
    expect(out.manual.join('\n')).toContain('board management is off')
    expect(out.manual.join('\n')).toContain('no one started this run')
    expect(calls.some((c) => c.fn === 'agentBoardsRequest' || c.fn === 'listTriggers')).toBe(false)
  })
})

describe('capabilities_configure', () => {
  test('reads the current state without writing', async () => {
    const ctx = baseCtx({ onCapabilitiesChanged: () => { throw new Error('should not reload') } })
    const out = await run(createCapabilitiesConfigureTool(ctx))
    expect(out.changed).toBe(false)
    expect(out.enabled).toContain('webEnabled')
    expect(out.disabled).toContain('gitWorktreesEnabled')
    expect(out.locked).toEqual([])
    expect(calls.find((c) => c.fn === 'configureProject')).toBeUndefined()
  })

  test('writes through the project config API and reloads', async () => {
    internalApiCredentials = true
    let reloaded = 0
    const ctx = baseCtx({ onCapabilitiesChanged: async () => { reloaded++ } })
    const out = await run(createCapabilitiesConfigureTool(ctx), { changes: { channelsEnabled: false } })
    expect(out.changed).toBe(true)
    expect(out.applies).toBe('next turn')
    expect(out.disabled).toContain('channelsEnabled')
    expect(calls.find((c) => c.fn === 'configureProject')?.args).toEqual([
      'caller-1',
      { settings: { channelsEnabled: false } },
    ])
    expect(reloaded).toBe(1)
    const saved = JSON.parse(readFileSync(join(workspaceDir, 'config.json'), 'utf-8'))
    expect(saved.channelsEnabled).toBe(false)
    expect(saved.webEnabled).toBe(true)
  })

  test('turning canvas off also sets activeMode to none', async () => {
    internalApiCredentials = true
    const ctx = baseCtx()
    const out = await run(createCapabilitiesConfigureTool(ctx), { changes: { canvasEnabled: false } })
    expect(out.changed).toBe(true)
    expect(out.capabilities.canvasEnabled).toBe(false)
    expect(calls.find((c) => c.fn === 'configureProject')?.args[1]).toEqual({
      settings: { canvasEnabled: false, activeMode: 'none' },
    })
    const saved = JSON.parse(readFileSync(join(workspaceDir, 'config.json'), 'utf-8'))
    expect(saved.canvasEnabled).toBe(false)
    expect(saved.activeMode).toBe('none')
  })

  test('without API credentials, merges the patch into config.json and preserves other flags', async () => {
    writeFileSync(join(workspaceDir, 'config.json'), JSON.stringify({
      webEnabled: false,
      model: { name: 'kept' },
    }))
    let reloaded = 0
    const ctx = baseCtx({
      config: {
        ...(baseCtx().config),
        webEnabled: false,
      },
      onCapabilitiesChanged: () => { reloaded++ },
    })
    const out = await run(createCapabilitiesConfigureTool(ctx), { changes: { imageGenEnabled: false } })
    expect(out.changed).toBe(true)
    expect(calls.find((c) => c.fn === 'configureProject')).toBeUndefined()
    expect(reloaded).toBe(1)
    const saved = JSON.parse(readFileSync(join(workspaceDir, 'config.json'), 'utf-8'))
    expect(saved.imageGenEnabled).toBe(false)
    expect(saved.webEnabled).toBe(false)
    expect(saved.model).toEqual({ name: 'kept' })
  })

  test('advertises threeDGenEnabled in the changes schema', () => {
    const tool = createCapabilitiesConfigureTool(baseCtx())
    const properties = (tool.parameters as any).properties.changes.properties
    expect(Object.keys(properties)).toContain('threeDGenEnabled')
    expect(properties.threeDGenEnabled.description).toBe('3D generation')
    expect(properties.videoGenEnabled.description).toBe('Video generation')
  })

  test('rejects an unknown capability', async () => {
    const out = await run(createCapabilitiesConfigureTool(baseCtx()), { changes: { notACapability: true } })
    expect(out.code).toBe('unknown_capability')
    expect(existsSync(join(workspaceDir, 'config.json'))).toBe(false)
  })

  test('rejects a capability locked by the personal profile', async () => {
    internalApiCredentials = true
    const ctx = baseCtx({
      config: { ...(baseCtx().config), capabilityProfile: 'personal', shellEnabled: false },
    })
    const out = await run(createCapabilitiesConfigureTool(ctx), { changes: { shellEnabled: true } })
    expect(out.code).toBe('capability_locked')
    expect(calls.find((c) => c.fn === 'configureProject')).toBeUndefined()
    expect(existsSync(join(workspaceDir, 'config.json'))).toBe(false)
  })

  test('in a workspace chat the read reports the workspace scope by default', async () => {
    const ctx = baseCtx({
      capabilityScope: 'workspace',
      capabilityConfigs: {
        workspace: { channels: [], model: { provider: 'anthropic', name: 'x' }, boardAdminEnabled: false } as any,
        project: { channels: [], model: { provider: 'anthropic', name: 'x' }, boardAdminEnabled: true } as any,
      },
    })
    const out = await run(createCapabilitiesConfigureTool(ctx))
    expect(out.scope).toBe('workspace')
    expect(out.disabled).toContain('boardAdminEnabled')
  })

  test('a project chat reads project scope even when a scope default exists', async () => {
    const ctx = baseCtx({
      capabilityScope: 'project',
      capabilityConfigs: {
        workspace: { channels: [], model: { provider: 'anthropic', name: 'x' }, boardAdminEnabled: false } as any,
        project: { channels: [], model: { provider: 'anthropic', name: 'x' }, boardAdminEnabled: true } as any,
      },
    })
    const out = await run(createCapabilitiesConfigureTool(ctx))
    expect(out.scope).toBe('project')
    expect(out.enabled).toContain('boardAdminEnabled')
  })

  test('workspace scope writes Workspace.settings, never the anchor project', async () => {
    internalApiCredentials = true
    let reloaded = 0
    const ctx = baseCtx({
      capabilityScope: 'workspace',
      onCapabilitiesChanged: async () => { reloaded++ },
    })
    const out = await run(createCapabilitiesConfigureTool(ctx), {
      changes: { boardAdminEnabled: false },
    })
    expect(out.changed).toBe(true)
    expect(out.scope).toBe('workspace')
    expect(calls.find((c) => c.fn === 'configureProject')).toBeUndefined()
    expect(calls.find((c) => c.fn === 'configureWorkspace')?.args).toEqual([
      'ws-1',
      { settings: { boardAdminEnabled: false } },
    ])
    expect(reloaded).toBe(1)
  })

  test('workspace scope caches under workspaceCapabilities and leaves the project keys alone', async () => {
    const ctx = baseCtx({ capabilityScope: 'workspace' })
    await run(createCapabilitiesConfigureTool(ctx), { changes: { boardAdminEnabled: false } })
    const saved = JSON.parse(readFileSync(join(workspaceDir, 'config.json'), 'utf-8'))
    expect(saved.workspaceCapabilities.boardAdminEnabled).toBe(false)
    // The flat keys are the project's cache; a workspace toggle must not land there.
    expect(saved.boardAdminEnabled).toBeUndefined()
  })

  test('an explicit project scope from a workspace chat patches the project', async () => {
    internalApiCredentials = true
    const ctx = baseCtx({ capabilityScope: 'workspace' })
    const out = await run(createCapabilitiesConfigureTool(ctx), {
      scope: 'project',
      changes: { shellEnabled: false },
    })
    expect(out.scope).toBe('project')
    expect(calls.find((c) => c.fn === 'configureProject')?.args).toEqual([
      'caller-1',
      { settings: { shellEnabled: false } },
    ])
    expect(calls.find((c) => c.fn === 'configureWorkspace')).toBeUndefined()
  })

  test('a locked capability is refused on the workspace scope too', async () => {
    internalApiCredentials = true
    const ctx = baseCtx({
      capabilityScope: 'workspace',
      capabilityConfigs: {
        workspace: { channels: [], model: { provider: 'anthropic', name: 'x' }, capabilityProfile: 'personal', shellEnabled: false } as any,
        project: { channels: [], model: { provider: 'anthropic', name: 'x' } } as any,
      },
    })
    const out = await run(createCapabilitiesConfigureTool(ctx), { changes: { shellEnabled: true } })
    expect(out.code).toBe('capability_locked')
    expect(calls.find((c) => c.fn === 'configureWorkspace')).toBeUndefined()
  })

  test('a failed API write does not update the local cache', async () => {
    internalApiCredentials = true
    api.configure = { ok: false, status: 403, error: 'not allowed', code: 'forbidden' }
    let reloaded = 0
    const ctx = baseCtx({ onCapabilitiesChanged: () => { reloaded++ } })
    const out = await run(createCapabilitiesConfigureTool(ctx), { changes: { shellEnabled: false } })
    expect(out.code).toBe('forbidden')
    expect(reloaded).toBe(0)
    expect(existsSync(join(workspaceDir, 'config.json'))).toBe(false)
  })
})
