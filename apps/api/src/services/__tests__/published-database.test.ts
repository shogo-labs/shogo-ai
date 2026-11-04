// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-308 §1: one Postgres database per published environment, provisioned on
// publish and dropped on teardown. The cluster itself is faked (no admin pool in
// a unit test), so what these tests pin is the contract the publish path relies
// on: the names, the Secret, the pooler URL, and — the safety property — that
// the pod is only pointed at Postgres once the caller says the schema is applied.

import { describe, test, expect, beforeEach, mock } from 'bun:test'

const PROJECT = '6b67a256-8a1e-4419-8888-4a677782673b'

let provisionCalls: Array<{ projectId: string; opts: any }> = []
let dropCalls: Array<{ projectId: string; opts: any }> = []
let provisionImpl: (projectId: string, opts: any) => Promise<any>
let dropImpl: (projectId: string, opts: any) => Promise<void>
let envUpdates: any[] = []
let updateImpl: ((args: any) => Promise<any>) | null = null

mock.module('../database.service', () => ({
  provisionDatabase: async (projectId: string, opts: any) => {
    provisionCalls.push({ projectId, opts })
    return provisionImpl(projectId, opts)
  },
  dropDatabase: async (projectId: string, opts: any) => {
    dropCalls.push({ projectId, opts })
    return dropImpl(projectId, opts)
  },
  getProjectsDbPoolerHost: () => 'projects-pg-pooler-rw.shogo-system.svc.cluster.local',
  getProjectsDbHost: () => 'projects-pg-rw.shogo-system.svc.cluster.local',
  getProjectsDbPort: () => 5432,
  dbSecretName: (projectId: string) => `project-${projectId}-db-creds`,
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    publishedEnvironment: {
      updateMany: async (args: any) => {
        envUpdates.push(args)
        if (updateImpl) return updateImpl(args)
        return { count: 1 }
      },
    },
  },
}))

const { ensureEnvironmentDatabase, dropEnvironmentDatabase } = await import(
  '../published-database.service'
)

beforeEach(() => {
  provisionCalls = []
  dropCalls = []
  envUpdates = []
  updateImpl = null
  provisionImpl = async (_projectId, opts) => ({
    databaseName: opts.databaseName,
    username: opts.databaseName,
    password: 'pw',
    connectionUrl: `postgres://${opts.databaseName}:pw@projects-pg-rw.shogo-system.svc.cluster.local:5432/${opts.databaseName}`,
    host: 'projects-pg-rw.shogo-system.svc.cluster.local',
    port: 5432,
  })
  dropImpl = async () => {}
})

describe('ensureEnvironmentDatabase', () => {
  test('provisions one database per environment, named after project + env', async () => {
    const prod = await ensureEnvironmentDatabase(PROJECT, 'production')
    const staging = await ensureEnvironmentDatabase(PROJECT, 'staging')

    expect(prod.ok).toBe(true)
    expect(staging.ok).toBe(true)
    expect(provisionCalls[0]!.opts.databaseName).toBe(
      'project_6b67a256_8a1e_4419_8888_4a677782673b',
    )
    expect(provisionCalls[1]!.opts.databaseName).toBe(
      'project_6b67a256_8a1e_4419_8888_4a677782673b_staging',
    )
    expect(provisionCalls[0]!.opts.secretName).toBe(`published-db-${PROJECT}-production`)
    expect(provisionCalls[1]!.opts.secretName).toBe(`published-db-${PROJECT}-staging`)
  })

  test('hands back a pooled URL, never the direct primary one', async () => {
    const res = await ensureEnvironmentDatabase(PROJECT, 'production')
    if (!res.ok) throw new Error(res.message)

    const url = new URL(res.value.url)
    expect(url.hostname).toBe('projects-pg-pooler-rw.shogo-system.svc.cluster.local')
    expect(url.searchParams.get('pgbouncer')).toBe('true')
    expect(url.searchParams.get('connection_limit')).toBe('5')
  })

  test('does not point the pod at Postgres until the schema is applied', async () => {
    await ensureEnvironmentDatabase(PROJECT, 'production')

    // provisionDatabase must not write the Secret the ksvc mounts, or the next
    // pod boot would serve an empty database instead of the SQLite archive.
    expect(provisionCalls[0]!.opts.writeSecret).toBe(false)
    // …and the row must not claim Postgres yet: the AC-6 replica guard reads it.
    expect(envUpdates[0]!.data.dbProvider).toBeUndefined()
    expect(envUpdates[0]!.data.dbName).toBe('project_6b67a256_8a1e_4419_8888_4a677782673b')
  })

  test('exposeToPod marks the environment Postgres-backed and writes the Secret', async () => {
    const res = await ensureEnvironmentDatabase(PROJECT, 'production', { exposeToPod: true })
    expect(res.ok).toBe(true)

    expect(provisionCalls[0]!.opts.writeSecret).toBe(true)
    expect(envUpdates[0]!.data).toEqual({
      dbProvider: 'postgres',
      dbName: 'project_6b67a256_8a1e_4419_8888_4a677782673b',
    })
    expect(envUpdates[0]!.where).toEqual({ projectId: PROJECT, name: 'production' })
  })

  test('a deployment without the cluster refuses with database_unavailable, not a throw', async () => {
    provisionImpl = async () => {
      throw new Error('PROJECTS_DB_ADMIN_URL is not configured. Cannot connect to projects database.')
    }

    const res = await ensureEnvironmentDatabase(PROJECT, 'production')

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('database_unavailable')
    expect(res.status).toBe(503)
    // Nothing was recorded, so a failed publish leaves the environment as it was.
    expect(envUpdates).toHaveLength(0)
  })

  test('any other provisioning error keeps its own code', async () => {
    provisionImpl = async () => {
      throw new Error('permission denied for database postgres')
    }

    const res = await ensureEnvironmentDatabase(PROJECT, 'staging')
    if (res.ok) throw new Error('expected a refusal')
    expect(res.code).toBe('database_provision_failed')
    expect(res.message).toContain('permission denied')
  })

  test('a bad project id is refused before any SQL runs', async () => {
    const res = await ensureEnvironmentDatabase('not-a-uuid', 'production')
    if (res.ok) throw new Error('expected a refusal')
    expect(res.code).toBe('invalid_project_id')
    expect(provisionCalls).toHaveLength(0)
  })

  test('a bookkeeping failure does not fail the publish', async () => {
    updateImpl = async () => {
      throw new Error('database is locked')
    }

    const res = await ensureEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(true)
  })
})

describe('dropEnvironmentDatabase', () => {
  test('drops the environment database and its Secret with the same names', async () => {
    const res = await dropEnvironmentDatabase(PROJECT, 'staging')

    expect(res.dropped).toBe(true)
    expect(dropCalls[0]!.opts.databaseName).toBe(
      'project_6b67a256_8a1e_4419_8888_4a677782673b_staging',
    )
    expect(dropCalls[0]!.opts.secretName).toBe(`published-db-${PROJECT}-staging`)
    expect(envUpdates[0]!.data).toEqual({ dbProvider: null, dbName: null })
  })

  test('reports a failed drop instead of throwing, so teardown keeps going', async () => {
    dropImpl = async () => {
      throw new Error('database is being accessed by other users')
    }

    const res = await dropEnvironmentDatabase(PROJECT, 'production')

    expect(res.dropped).toBe(false)
    expect(res.error).toContain('being accessed')
    expect(envUpdates).toHaveLength(0)
  })
})
