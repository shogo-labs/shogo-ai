// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Capability toggles are pulled from Project.settings. config.json is only
 * a last-known cache, and a personal workspace profile still wins over
 * whatever the database says about shell access.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { applyCapabilityProfile } from '../capability-profiles'
import { mergeCapabilitySettingsIntoConfig } from '@shogo/shared-runtime/capability-settings'

const savedEnv = {
  PROJECT_ID: process.env.PROJECT_ID,
  WORKSPACE_KIND: process.env.WORKSPACE_KIND,
  RUNTIME_AUTH_SECRET: process.env.RUNTIME_AUTH_SECRET,
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'capability-sync-'))
}

describe('syncCapabilitiesFromApi', () => {
  test('database values replace a stale config.json and keep unrelated keys', async () => {
    const dir = workspace()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      socialMediaEnabled: false,
      webEnabled: false,
      model: { provider: 'anthropic', name: 'kept' },
    }))
    process.env.PROJECT_ID = 'proj-sync'
    const gw = new AgentGateway(dir, 'proj-sync')

    const applied = await gw.syncCapabilitiesFromApi(async (projectId) => {
      expect(projectId).toBe('proj-sync')
      return {
        ok: true,
        data: { settings: { socialMediaEnabled: true, webEnabled: true } },
      }
    })

    expect(applied).toBe(true)
    const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))
    expect(file.socialMediaEnabled).toBe(true)
    expect(file.webEnabled).toBe(true)
    expect(file.gitWorktreesEnabled).toBe(false)
    expect(file.model).toEqual({ provider: 'anthropic', name: 'kept' })
    expect((gw as { config: { socialMediaEnabled?: boolean } }).config.socialMediaEnabled).toBe(true)
  })

  test('keeps the cache when the API cannot be reached', async () => {
    const dir = workspace()
    const original = {
      socialMediaEnabled: true,
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify(original))
    process.env.PROJECT_ID = 'proj-sync'
    const gw = new AgentGateway(dir, 'proj-sync')

    const applied = await gw.syncCapabilitiesFromApi(async () => ({ ok: false }))

    expect(applied).toBe(false)
    const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))
    expect(file).toEqual(original)
    expect((gw as { config: { socialMediaEnabled?: boolean } }).config.socialMediaEnabled).toBe(true)
  })

  test('skips workspace runtimes that have no project id', async () => {
    const dir = workspace()
    process.env.PROJECT_ID = 'ws:workspace-1'
    const gw = new AgentGateway(dir, 'ws:workspace-1')
    let called = false
    const applied = await gw.syncCapabilitiesFromApi(async () => {
      called = true
      return { ok: true, data: { settings: { socialMediaEnabled: true } } }
    })
    expect(applied).toBe(false)
    expect(called).toBe(false)
  })

  test('skips the pull when this process cannot authenticate to the API', async () => {
    const dir = workspace()
    delete process.env.RUNTIME_AUTH_SECRET
    process.env.PROJECT_ID = 'proj-sync'
    const gw = new AgentGateway(dir, 'proj-sync')
    expect(await gw.syncCapabilitiesFromApi()).toBe(false)
  })

  test('a personal profile still forces shell off after the database is applied', async () => {
    const dir = workspace()
    process.env.PROJECT_ID = 'proj-sync'
    process.env.WORKSPACE_KIND = 'personal'
    const gw = new AgentGateway(dir, 'proj-sync')

    await gw.syncCapabilitiesFromApi(async () => ({
      ok: true,
      data: {
        settings: {
          shellEnabled: true,
          socialMediaEnabled: true,
          gitWorktreesEnabled: true,
        },
      },
    }))

    const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))
    expect(file.shellEnabled).toBe(true)
    expect(file.socialMediaEnabled).toBe(true)

    const loaded = new AgentGateway(dir, 'proj-sync')
    const config = (loaded as { config: { shellEnabled?: boolean; socialMediaEnabled?: boolean } }).config
    expect(config.shellEnabled).toBe(false)
    expect(config.socialMediaEnabled).toBe(true)

    const merged = mergeCapabilitySettingsIntoConfig({}, { shellEnabled: true })
    const profiled = applyCapabilityProfile(
      { ...merged.config, channels: [] as [], model: { provider: 'anthropic', name: 'x' } },
      'personal',
    )
    expect(profiled.shellEnabled).toBe(false)
  })
})

describe('capability sync is wired into boot and config updates', () => {
  test('gateway start pulls capabilities before the first turn', async () => {
    const source = await Bun.file(new URL('../gateway.ts', import.meta.url)).text()
    const startAt = source.indexOf('async start(): Promise<void>')
    const start = source.slice(startAt, startAt + 900)
    expect(start).toContain('syncCapabilitiesFromApi')
  })

  test('PATCH /agent/config confirms capability keys against the database', async () => {
    const source = await Bun.file(new URL('../server.ts', import.meta.url)).text()
    const handler = source.slice(
      source.indexOf("app.patch('/agent/config'"),
      source.indexOf("app.get('/agent/worktrees'"),
    )
    expect(handler).toContain('syncCapabilitiesFromApi')
  })
})
