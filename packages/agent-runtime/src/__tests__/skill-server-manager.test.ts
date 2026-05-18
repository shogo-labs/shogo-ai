// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { SkillServerManager } from '../skill-server-manager'
import type { PreviewManager } from '../preview-manager'

function fakePm(over: Partial<PreviewManager> = {}): PreviewManager {
  return {
    apiServerPort: 4123,
    apiServerPhase: 'healthy',
    apiServerUrl: 'http://localhost:4123',
    apiLastGenerateError: null,
    getActiveRoutes: () => ['/api/foo', '/api/bar'],
    getSchemaModels: () => ['User', 'Project'],
    sync: mock(async () => ({ ok: true, phase: 'healthy' as const })),
    restartApiServerOnly: mock(async () => {}),
    ...over,
  } as unknown as PreviewManager
}

const savedEnv: Record<string, string | undefined> = {}
function setEnv(k: string, v?: string) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete savedEnv[k]
  }
})

describe('SkillServerManager — unattached (no PreviewManager yet)', () => {
  it('falls back to the default 3001 port', () => {
    setEnv('API_SERVER_PORT', undefined)
    setEnv('SKILL_SERVER_PORT', undefined)
    const m = new SkillServerManager({ workspaceDir: '/tmp/x' })
    expect(m.port).toBe(3001)
    expect(m.phase).toBe('idle')
    expect(m.isRunning).toBe(false)
    expect(m.url).toBe('http://localhost:3001')
    expect(m.lastGenerateError).toBeNull()
    expect(m.hasCustomRoutes).toBe(true)
    expect(m.getActiveRoutes()).toEqual([])
    expect(m.getSchemaModels()).toEqual([])
  })

  it('honors API_SERVER_PORT', () => {
    setEnv('API_SERVER_PORT', '5500')
    setEnv('SKILL_SERVER_PORT', undefined)
    const m = new SkillServerManager({ workspaceDir: '/tmp/x' })
    expect(m.port).toBe(5500)
    expect(m.url).toBe('http://localhost:5500')
  })

  it('falls through to legacy SKILL_SERVER_PORT when API_SERVER_PORT is unset', () => {
    setEnv('API_SERVER_PORT', undefined)
    setEnv('SKILL_SERVER_PORT', '6600')
    const m = new SkillServerManager({ workspaceDir: '/tmp/x' })
    expect(m.port).toBe(6600)
  })

  it('ignores non-numeric / non-positive env values', () => {
    setEnv('API_SERVER_PORT', 'NaN')
    setEnv('SKILL_SERVER_PORT', '0')
    const m = new SkillServerManager({ workspaceDir: '/tmp/x' })
    expect(m.port).toBe(3001)
  })

  it('sync() returns error envelope and restart()/restartApiServerOnly() are no-ops', async () => {
    const m = new SkillServerManager({ workspaceDir: '/tmp/x' })
    const r = await m.sync()
    expect(r).toEqual({ ok: false, phase: 'idle', error: 'PreviewManager not attached' })
    await expect(m.restart()).resolves.toBeUndefined()
    await expect(m.restartApiServerOnly()).resolves.toBeUndefined()
  })

  it('start() reports not-started, stop() is a no-op', async () => {
    const m = new SkillServerManager({ workspaceDir: '/tmp/x' })
    expect(await m.start()).toEqual({ started: false, port: null })
    await expect(m.stop()).resolves.toBeUndefined()
  })
})

describe('SkillServerManager — attached', () => {
  let m: SkillServerManager
  let pm: PreviewManager
  beforeEach(() => {
    pm = fakePm()
    m = new SkillServerManager({ workspaceDir: '/tmp/x' })
    m.attach(pm)
  })

  it('proxies port / phase / url / lastGenerateError / routes / models', () => {
    expect(m.port).toBe(4123)
    expect(m.phase).toBe('healthy')
    expect(m.isRunning).toBe(true)
    expect(m.url).toBe('http://localhost:4123')
    expect(m.lastGenerateError).toBeNull()
    expect(m.getActiveRoutes()).toEqual(['/api/foo', '/api/bar'])
    expect(m.getSchemaModels()).toEqual(['User', 'Project'])
  })

  it('isRunning is false when phase is not healthy', () => {
    pm = fakePm({ apiServerPhase: 'starting' as any })
    m = new SkillServerManager({ workspaceDir: '/tmp/x' })
    m.attach(pm)
    expect(m.isRunning).toBe(false)
  })

  it('sync() delegates to PreviewManager.sync', async () => {
    const r = await m.sync()
    expect(r).toEqual({ ok: true, phase: 'healthy' })
    expect((pm.sync as ReturnType<typeof mock>)).toHaveBeenCalledTimes(1)
  })

  it('restart() also delegates to sync()', async () => {
    await m.restart()
    expect((pm.sync as ReturnType<typeof mock>)).toHaveBeenCalledTimes(1)
  })

  it('restartApiServerOnly() delegates to PreviewManager.restartApiServerOnly', async () => {
    await m.restartApiServerOnly()
    expect((pm.restartApiServerOnly as ReturnType<typeof mock>)).toHaveBeenCalledTimes(1)
  })

  it('start() reports started=true when the port is non-null', async () => {
    const r = await m.start()
    expect(r).toEqual({ started: true, port: 4123 })
  })

  it('start() reports started=false when port is null', async () => {
    pm = fakePm({ apiServerPort: null as any })
    m = new SkillServerManager({ workspaceDir: '/tmp/x' })
    m.attach(pm)
    expect(await m.start()).toEqual({ started: false, port: null })
  })
})

describe('SkillServerManager.prewarmDeps', () => {
  it('returns false (no-op)', () => {
    expect(SkillServerManager.prewarmDeps('/anywhere')).toBe(false)
  })
})
