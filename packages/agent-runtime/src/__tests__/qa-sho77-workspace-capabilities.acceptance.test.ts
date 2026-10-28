// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-77 acceptance — the workspace agent knows and toggles its OWN
 * capabilities, and those toggles land on the workspace, never on the anchor
 * project the runtime happens to be pinned to.
 *
 * The dev's unit tests pin each piece with fakes. This file composes the real
 * chain the user actually drives, over a real SQLite database built from the
 * desktop migration history:
 *
 *   `capabilities_configure` (workspace turn)
 *     → the real internal-API client (`configureWorkspace` in internal-api.ts,
 *       real URL/shape, fetch served by the real service)
 *     → `Workspace.settings` (encoded for SQLite, read back as an object)
 *     → `syncCapabilitiesFromApi` → `configForTurn` → tool gating next turn
 *
 * and proves the anchor project's `Project.settings` row is byte-identical
 * throughout. Also covers AC4: the toggles survive a restart because the DB is
 * the source of truth (`config.json` is only a cache, even a stale one).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupChannelsTestDb } from '../../../../apps/api/src/__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../../apps/api/src/lib/prisma')
const { readWorkspaceConfig, configureWorkspace } = await import('../../../../apps/api/src/services/workspace.service')
const { AgentGateway } = await import('../gateway')
const { filterDisabledCapabilityTools } = await import('../gateway-tools')
const { createCapabilitiesConfigureTool } = await import('../project-tools')
const { buildCapabilityStatusSection } = await import('../capability-status-prompt')
const { parseProjectSettings } = await import('../../../../apps/api/src/lib/project-settings')

const WS = 'qa77-workspace'
const ANCHOR = 'qa77-anchor-project'

const ENV_KEYS = ['WORKSPACE_RUNTIME', 'WORKSPACE_KIND', 'WORKSPACE_ID', 'WORKSPACE_ANCHOR_PROJECT_ID', 'PROJECT_ID', 'SHOGO_API_URL', 'RUNTIME_AUTH_SECRET'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

const realFetch = globalThis.fetch
/** Every internal-API call the runtime made, so the test can prove the target. */
const internalCalls: Array<{ method: string; path: string; body?: any }> = []

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Serve the two internal config routes from the REAL services. This is what
 * the runtime would hit over HTTP; only the socket is stubbed, so the client
 * helper, the URL, the request shape and the SQLite encode/decode all run.
 */
globalThis.fetch = (async (input: any, init?: any) => {
  const raw = typeof input === 'string' ? input : input.url
  const url = new URL(String(raw))
  const method = (init?.method ?? 'GET').toUpperCase()
  const match = url.pathname.match(/^\/api\/internal\/(workspaces|projects)\/([^/]+)\/config$/)
  if (!match) {
    internalCalls.push({ method, path: url.pathname })
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }
  const [, kind, id] = match
  internalCalls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })

  if (kind === 'workspaces') {
    if (method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      return json({ ok: true, workspace: await configureWorkspace(id, { settings: body.settings }) })
    }
    return json({ ok: true, workspace: await readWorkspaceConfig(id) })
  }
  // A project's config is read-only here: the workspace turn must never PATCH it.
  const project = await prisma.project.findUnique({ where: { id }, select: { settings: true } })
  if (!project) return json({ error: { code: 'not_found', message: 'project not found' } }, 404)
  const settings = typeof project.settings === 'string' ? JSON.parse(project.settings) : project.settings
  return json({ ok: true, project: { id, settings: settings ?? null } })
}) as typeof fetch

function workspaceDir(config: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-sho77-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2))
  return dir
}

/** A runtime pinned to the anchor project, serving workspace chats and its own. */
function pinnedRuntime(dir: string): InstanceType<typeof AgentGateway> {
  process.env.WORKSPACE_RUNTIME = 'true'
  process.env.WORKSPACE_KIND = 'team'
  process.env.WORKSPACE_ID = WS
  process.env.WORKSPACE_ANCHOR_PROJECT_ID = ANCHOR
  process.env.PROJECT_ID = ANCHOR
  process.env.SHOGO_API_URL = 'http://qa-sho77.test'
  process.env.RUNTIME_AUTH_SECRET = 'qa-sho77-runtime-secret'
  return new AgentGateway(dir, ANCHOR)
}

/**
 * The anchor project's stored settings, in a form that can be compared
 * byte-for-byte. The SQLite wrapper already decodes JSON columns on read, so
 * canonicalise whatever comes back instead of assuming an encoding.
 */
const anchorSettingsRaw = async (): Promise<string> => {
  const row = await prisma.project.findUnique({ where: { id: ANCHOR }, select: { settings: true } })
  return JSON.stringify(row?.settings ?? null)
}

const workspaceSettingsRaw = async (): Promise<unknown> => {
  const row = await prisma.workspace.findUnique({ where: { id: WS }, select: { settings: true } })
  return row?.settings
}

/** Set the workspace's own toggles to a known state (tests must not inherit). */
const seedWorkspaceToggles = async (settings: Record<string, unknown>) => {
  await configureWorkspace(WS, { settings })
}

const boardToolNames = ['board_create', 'column_create', 'column_update', 'exec']
const tools = boardToolNames.map((name) => ({ name }) as never)
const names = (list: Array<{ name: string }>) => list.map((t) => t.name)

/** Minimal ToolContext for the capability tool: only what it reads. */
function capabilityContext(gw: InstanceType<typeof AgentGateway>) {
  return {
    workspaceDir: mkdtempSync(join(tmpdir(), 'qa-sho77-ctx-')),
    channels: new Map(),
    config: gw.configForTurn('ws-session', 'workspace'),
    capabilityScope: 'workspace' as const,
    capabilityConfigs: {
      workspace: gw.configForTurn('ws-session', 'workspace'),
      project: gw.configForTurn('proj-session', 'project'),
    },
    projectId: ANCHOR,
    workspaceId: WS,
    onCapabilitiesChanged: async () => {
      await gw.syncCapabilitiesFromApi()
    },
  }
}

const runTool = async (tool: { execute: (id: string, params: any) => Promise<any> }, params: Record<string, unknown> = {}) => {
  const result = await tool.execute('qa-sho77-call', params)
  return result.details as any
}

describe('SHO-77 acceptance — the workspace agent owns its capability toggles', () => {
  afterAll(async () => {
    globalThis.fetch = realFetch
    await prisma.project.deleteMany({ where: { id: ANCHOR } })
    await prisma.workspace.deleteMany({ where: { id: WS } })
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('seed: anchor project carries its own board toggles, workspace starts empty', async () => {
    await prisma.workspace.create({
      data: { id: WS, name: 'QA 77 Workspace', slug: 'qa77-workspace', kind: 'team' },
    })
    await prisma.project.create({
      data: {
        id: ANCHOR,
        name: 'Shogo Planner',
        workspaceId: WS,
        settings: JSON.stringify({ boardAdminEnabled: true, shellEnabled: true, activeMode: 'canvas', canvasEnabled: false }),
      },
    })
    expect(await workspaceSettingsRaw()).toBeNull()
    expect(JSON.parse(await anchorSettingsRaw())).toMatchObject({ boardAdminEnabled: true })
  })

  test('a workspace-scope write lands on Workspace.settings in a decodable form, and never touches the anchor', async () => {
    const anchorBefore = await anchorSettingsRaw()

    const snapshot = await configureWorkspace(WS, { settings: { boardAdminEnabled: false, shellEnabled: false } })
    expect(snapshot.settings).toMatchObject({ boardAdminEnabled: false, shellEnabled: false })

    // Whatever the column holds must decode to the settings object through the
    // app's own reader — that is what makes the value survive a restart.
    const raw = await workspaceSettingsRaw()
    expect(parseProjectSettings(raw)).toMatchObject({ boardAdminEnabled: false, shellEnabled: false })

    // A later patch merges instead of replacing the workspace's other settings.
    const merged = await configureWorkspace(WS, { settings: { webEnabled: false } })
    expect(merged.settings).toMatchObject({ boardAdminEnabled: false, shellEnabled: false, webEnabled: false })

    expect(await anchorSettingsRaw()).toBe(anchorBefore)
  })

  test('the workspace turn reads the workspace toggles; the anchor project keeps its own', async () => {
    await seedWorkspaceToggles({ boardAdminEnabled: false, shellEnabled: false })
    const gw = pinnedRuntime(workspaceDir({
      boardAdminEnabled: true,
      shellEnabled: true,
      canvasEnabled: false,
      activeMode: 'canvas',
    }))
    expect(await gw.syncCapabilitiesFromApi()).toBe(true)

    const workspaceTurn = gw.configForTurn('ws-session', 'workspace')
    expect(workspaceTurn.boardAdminEnabled).toBe(false)
    expect(names(filterDisabledCapabilityTools(tools, workspaceTurn))).not.toContain('board_create')

    const projectTurn = gw.configForTurn('proj-session', 'project')
    expect(projectTurn.boardAdminEnabled).toBe(true)
    expect(names(filterDisabledCapabilityTools(tools, projectTurn))).toContain('board_create')
    expect(names(filterDisabledCapabilityTools(tools, projectTurn))).toContain('column_create')
  })

  test('a workspace chat reads scope "workspace" with no args, and writes through the workspace config route', async () => {
    await seedWorkspaceToggles({ boardAdminEnabled: false, shellEnabled: false })
    const gw = pinnedRuntime(workspaceDir({ boardAdminEnabled: true, activeMode: 'canvas' }))
    await gw.syncCapabilitiesFromApi()
    const anchorBefore = await anchorSettingsRaw()
    const projectPatchesBefore = internalCalls.filter((c) => c.method === 'PATCH' && c.path.startsWith('/api/internal/projects/')).length

    const ctx = capabilityContext(gw)
    const read = await runTool(createCapabilitiesConfigureTool(ctx as never))
    expect(read.scope).toBe('workspace')
    expect(read.disabled).toContain('boardAdminEnabled')

    const wrote = await runTool(createCapabilitiesConfigureTool(ctx as never), { changes: { boardAdminEnabled: true } })
    expect(wrote.scope).toBe('workspace')
    expect(wrote.changed).toBe(true)
    expect(wrote.enabled).toContain('boardAdminEnabled')

    // The write went to the workspace route, not a project's.
    const scopePatch = internalCalls.find((c) => c.method === 'PATCH' && c.path === `/api/internal/workspaces/${WS}/config`)
    expect(scopePatch?.body).toEqual({ settings: { boardAdminEnabled: true } })
    expect(internalCalls.filter((c) => c.method === 'PATCH' && c.path.startsWith('/api/internal/projects/')).length)
      .toBe(projectPatchesBefore)

    // Durable in the DB, and the anchor row is byte-identical.
    const stored = await readWorkspaceConfig(WS)
    expect(stored.settings.boardAdminEnabled).toBe(true)
    expect(await anchorSettingsRaw()).toBe(anchorBefore)
  })

  test('the toggle takes effect on the next turn: workspace board tools return, the project is unaffected', async () => {
    await seedWorkspaceToggles({ boardAdminEnabled: false })
    const gw = pinnedRuntime(workspaceDir({ boardAdminEnabled: false, activeMode: 'canvas' }))
    await gw.syncCapabilitiesFromApi()
    expect(names(filterDisabledCapabilityTools(tools, gw.configForTurn('ws-session', 'workspace'))))
      .not.toContain('board_create')

    const ctx = capabilityContext(gw)
    await runTool(createCapabilitiesConfigureTool(ctx as never), { changes: { boardAdminEnabled: true } })

    // `onCapabilitiesChanged` re-syncs from the DB, exactly as a turn boundary does.
    const nextTurn = gw.configForTurn('ws-session', 'workspace')
    expect(nextTurn.boardAdminEnabled).toBe(true)
    expect(names(filterDisabledCapabilityTools(tools, nextTurn))).toContain('board_create')
    expect(names(filterDisabledCapabilityTools(tools, nextTurn))).toContain('column_create')

    // The anchor's own project turn still reads its own toggles.
    const projectTurn = gw.configForTurn('proj-session', 'project')
    expect(projectTurn.boardAdminEnabled).toBe(true)
  })

  test('toggles survive a restart because the DB wins, even over a stale config.json cache', async () => {
    await seedWorkspaceToggles({ boardAdminEnabled: true, shellEnabled: false })
    // A runtime that has never seen this workspace: no cache at all.
    const cold = pinnedRuntime(workspaceDir({}))
    expect(await cold.syncCapabilitiesFromApi()).toBe(true)
    expect(cold.configForTurn('ws-session', 'workspace').boardAdminEnabled).toBe(true)

    // And a runtime whose cache disagrees with the DB: the DB wins.
    const staleDir = workspaceDir({
      workspaceCapabilities: { boardAdminEnabled: false, shellEnabled: false },
      boardAdminEnabled: true,
    })
    const warm = pinnedRuntime(staleDir)
    expect(await warm.syncCapabilitiesFromApi()).toBe(true)
    expect(warm.configForTurn('ws-session', 'workspace').boardAdminEnabled).toBe(true)
    const cache = JSON.parse(readFileSync(join(staleDir, 'config.json'), 'utf-8'))
    expect(cache.workspaceCapabilities.boardAdminEnabled).toBe(true)

    // The workspace cache and the project cache stay separate blobs.
    expect(cache.workspaceCapabilities).toBeDefined()
    expect(cache.shellEnabled).toBe(true)
  })

  test('the prompt block is the workspace\'s own, and cannot claim canvas is off while the runtime is in canvas mode', () => {
    // The exact live drift the card reported: the anchor's stale
    // `canvasEnabled: false` rendered as the workspace agent's own state.
    const gw = pinnedRuntime(workspaceDir({
      canvasEnabled: false,
      activeMode: 'canvas',
      boardAdminEnabled: true,
      shellEnabled: true,
    }))
    const workspaceTurn = gw.configForTurn('ws-session', 'workspace')
    expect(workspaceTurn.canvasEnabled).toBe(true)

    const block = buildCapabilityStatusSection(workspaceTurn, {
      scope: 'workspace',
      anchorProjectName: 'Shogo Planner',
    })
    expect(block.split('\n')[0]).toBe('## Workspace capabilities')
    expect(block).not.toContain('## Project capabilities')
    expect(block).not.toContain('Canvas (`canvasEnabled`) — off')
    expect(block).toContain('canvasEnabled')
    // The anchor is named only as a separate pointer, never as the list above.
    expect(block).toContain('Shogo Planner')

    const projectBlock = buildCapabilityStatusSection(
      gw.configForTurn('proj-session', 'project'),
      { scope: 'project', projectName: 'Shogo Planner' },
    )
    expect(projectBlock.split('\n')[0]).toBe('## Project capabilities (Shogo Planner)')
    expect(projectBlock).not.toContain('## Workspace capabilities')
  })
})
