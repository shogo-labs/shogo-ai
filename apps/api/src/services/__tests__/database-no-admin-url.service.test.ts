// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Isolated test for the PROJECTS_DB_ADMIN_URL-unset branches. The module
// captures the env var into a const at load time, so toggling after import
// has no effect — this file deletes the var BEFORE the import.

import { describe, expect, it, mock } from 'bun:test'

delete process.env.PROJECTS_DB_ADMIN_URL

mock.module('pg', () => ({ Pool: class { on() {} async connect() { return {} } async end() {} } }))
mock.module('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromOptions() {}
    loadFromDefault() {}
    makeApiClient() { return {} }
  },
  CoreV1Api: class {},
}))
mock.module('fs', () => ({ existsSync: () => false, readFileSync: () => '' }))

// Capture the module-load console.error
const startupErrs: string[] = []
const origErr = console.error
console.error = (...args: any[]) => startupErrs.push(args.join(' '))
const svc = await import('../database.service')
console.error = origErr

describe('database.service with PROJECTS_DB_ADMIN_URL unset', () => {
  it('logs an error at module load', () => {
    expect(startupErrs.some((s) => s.includes('PROJECTS_DB_ADMIN_URL is not set'))).toBe(true)
  })

  it('getDatabaseStatus throws "not configured"', async () => {
    const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await expect(svc.getDatabaseStatus(UUID)).rejects.toThrow(/PROJECTS_DB_ADMIN_URL is not configured/)
  })

  it('testConnection swallows the error and returns false', async () => {
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      expect(await svc.testConnection()).toBe(false)
      expect(errs.some((e) => e.includes('Connection test failed'))).toBe(true)
    } finally {
      console.error = orig
    }
  })

  it('shutdown is still a no-op-safe', async () => {
    await svc.shutdown()
  })
})
