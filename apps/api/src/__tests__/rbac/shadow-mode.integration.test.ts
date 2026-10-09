// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RBAC_ENFORCE modes. `off` and `shadow` keep pre-RBAC behavior for callers
 * with a workspace role (shadow logs the would-deny); `on` enforces. Guest
 * isolation and Restricted visibility are enforced in every mode.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, seedRbacWorld, db, _setRbacModeForTests } = await import('../helpers/rbac-world')
const { getRbacMode, invalidateRbacMode, RBAC_MODE_SETTING_KEY } = await import('../../lib/authz')
type World = Awaited<ReturnType<typeof seedRbacWorld>>

let w: World
const app = buildRbacApp()
const as = (id: string) => ({ user: id })

beforeAll(async () => {
  w = await seedRbacWorld()
})

afterEach(() => _setRbacModeForTests(null))

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

const viewerWrite = () => call(app, as(w.users.viewer), 'POST', `/api/projects/${w.projects.open}/chat`, {})
const viewerPatch = () => call(app, as(w.users.viewer), 'PATCH', `/api/projects/${w.projects.open}`, { description: 'viewer' })

describe('modes', () => {
  test('off: viewer writes pass silently', async () => {
    _setRbacModeForTests('off')
    const warn = spyOn(console, 'warn')
    try {
      expect((await viewerWrite()).status).toBe(200)
      expect((await viewerPatch()).status).toBe(200)
      expect(warn.mock.calls.some((a) => String(a[0]).includes('[rbac] shadow-deny'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  test('shadow: viewer writes pass and log a would-deny record', async () => {
    _setRbacModeForTests('shadow')
    const warn = spyOn(console, 'warn')
    try {
      expect((await viewerWrite()).status).toBe(200)
      const record = warn.mock.calls.find((a) => String(a[0]).includes('[rbac] shadow-deny'))
      expect(record).toBeTruthy()
      expect(record![1]).toMatchObject({ permission: 'project:update', userId: w.users.viewer, workspaceRole: 'viewer' })
    } finally {
      warn.mockRestore()
    }
  })

  test('on: viewer writes are denied', async () => {
    _setRbacModeForTests('on')
    expect((await viewerWrite()).status).toBe(403)
    expect((await viewerPatch()).status).toBe(403)
  })

  for (const mode of ['off', 'shadow', 'on'] as const) {
    test(`${mode}: guests and restricted projects are always enforced`, async () => {
      _setRbacModeForTests(mode)
      expect((await call(app, as(w.users.guestViewer), 'POST', `/api/projects/${w.projects.open}/chat`, {})).status).toBe(403)
      expect((await call(app, as(w.users.guestViewer), 'GET', `/api/projects/${w.projects.restricted}`)).status).toBe(404)
      expect((await call(app, as(w.users.viewer), 'GET', `/api/projects/${w.projects.restricted}`)).status).toBe(404)
      expect((await call(app, as(w.users.viewer), 'POST', `/api/projects/${w.projects.restricted}/chat`, {})).status).toBe(404)
      expect((await call(app, as(w.users.outsider), 'GET', `/api/projects/${w.projects.open}`)).status).toBe(403)
    })

    test(`${mode}: replaced role checks stay strict`, async () => {
      _setRbacModeForTests(mode)
      expect((await call(app, as(w.users.member), 'PATCH', `/api/workspaces/${w.workspaceA}`, { description: 'm' })).status).toBe(403)
      expect((await call(app, as(w.users.viewer), 'PUT', `/api/projects/${w.projects.open}/auth-config`, {})).status).toBe(mode === 'on' ? 403 : 200)
    })
  }
})

describe('mode resolution', () => {
  test('platform setting is read when no env or override is set', async () => {
    const prevEnv = process.env.RBAC_ENFORCE
    delete process.env.RBAC_ENFORCE
    try {
      await db.platformSetting.upsert({
        where: { key: RBAC_MODE_SETTING_KEY },
        create: { key: RBAC_MODE_SETTING_KEY, value: 'on' },
        update: { value: 'on' },
      })
      invalidateRbacMode()
      expect(await getRbacMode()).toBe('on')
      await db.platformSetting.update({ where: { key: RBAC_MODE_SETTING_KEY }, data: { value: 'garbage' } })
      invalidateRbacMode()
      expect(await getRbacMode()).toBe('shadow')
      process.env.RBAC_ENFORCE = 'off'
      expect(await getRbacMode()).toBe('off')
    } finally {
      if (prevEnv === undefined) delete process.env.RBAC_ENFORCE
      else process.env.RBAC_ENFORCE = prevEnv
      await db.platformSetting.delete({ where: { key: RBAC_MODE_SETTING_KEY } }).catch(() => {})
      invalidateRbacMode()
    }
  })
})
