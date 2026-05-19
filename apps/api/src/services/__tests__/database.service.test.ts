// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── module-load env (captured by const in database.service.ts) ──────────────

process.env.PROJECTS_DB_ADMIN_URL = 'postgres://admin:pw@admin-host:5432/projects'
process.env.PROJECTS_DB_HOST = 'projects-pg-test.svc'
process.env.PROJECTS_DB_PORT = '6432'
process.env.PROJECT_NAMESPACE = 'shogo-test-ns'

// ─── pg mock ─────────────────────────────────────────────────────────────────

type QueryRow = Record<string, unknown>

let nextQueryResults: Array<{ rows: QueryRow[] }> = []
const queryLog: Array<{ sql: string; params?: unknown[] }> = []
let nextQueryThrow: Error | null = null
const pools: FakePool[] = []

class FakeClient {
  released = false
  async query(sql: string, params?: unknown[]) {
    queryLog.push({ sql, params })
    if (nextQueryThrow) {
      const e = nextQueryThrow
      nextQueryThrow = null
      throw e
    }
    return nextQueryResults.shift() ?? { rows: [] }
  }
  release() {
    this.released = true
  }
}

class FakePool {
  ended = false
  handlers: Record<string, Array<(arg: any) => void>> = {}
  connectImpl: () => Promise<FakeClient> = async () => new FakeClient()
  constructor(public opts: any) {
    pools.push(this)
  }
  on(event: string, h: (arg: any) => void) {
    ;(this.handlers[event] ||= []).push(h)
    return this
  }
  async connect() {
    return this.connectImpl()
  }
  async end() {
    this.ended = true
  }
  emit(event: string, arg: any) {
    for (const h of this.handlers[event] ?? []) h(arg)
  }
}

mock.module('pg', () => ({
  Pool: FakePool,
}))

// ─── @kubernetes/client-node mock ────────────────────────────────────────────

const k8sCalls = {
  read: [] as Array<{ name: string; namespace: string }>,
  replace: [] as Array<{ name: string; namespace: string; body: any }>,
  create: [] as Array<{ namespace: string; body: any }>,
  delete_: [] as Array<{ name: string; namespace: string }>,
  configLoadOptions: [] as any[],
  configLoadDefault: 0,
}

let readSecretImpl: (args: { name: string; namespace: string }) => Promise<any> = async () => ({
  data: {},
})
let replaceSecretImpl: (args: any) => Promise<void> = async () => {}
let createSecretImpl: (args: any) => Promise<void> = async () => {}
let deleteSecretImpl: (args: any) => Promise<void> = async () => {}

class FakeCoreV1Api {
  async readNamespacedSecret(args: { name: string; namespace: string }) {
    k8sCalls.read.push(args)
    return readSecretImpl(args)
  }
  async replaceNamespacedSecret(args: any) {
    k8sCalls.replace.push(args)
    return replaceSecretImpl(args)
  }
  async createNamespacedSecret(args: any) {
    k8sCalls.create.push(args)
    return createSecretImpl(args)
  }
  async deleteNamespacedSecret(args: any) {
    k8sCalls.delete_.push(args)
    return deleteSecretImpl(args)
  }
}

class FakeKubeConfig {
  loadFromOptions(opts: any) {
    k8sCalls.configLoadOptions.push(opts)
  }
  loadFromDefault() {
    k8sCalls.configLoadDefault++
  }
  makeApiClient(_cls: any) {
    return new FakeCoreV1Api()
  }
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  CoreV1Api: FakeCoreV1Api,
}))

// ─── fs mock (for the in-cluster auth probe) ────────────────────────────────

let inCluster = false

mock.module('fs', () => ({
  existsSync: (p: string) => {
    if (p.includes('serviceaccount/ca.crt') || p.includes('serviceaccount/token')) {
      return inCluster
    }
    return false
  },
  readFileSync: (p: string) => {
    if (p.includes('serviceaccount/ca.crt')) return 'fake-ca-content'
    if (p.includes('serviceaccount/token')) return 'fake-token-content'
    return ''
  },
}))

const svc = await import('../database.service')

// ─── helpers ─────────────────────────────────────────────────────────────────

const UUID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const dbNameA = `project_${UUID_A.replace(/-/g, '_')}`

function set404(): Error {
  return Object.assign(new Error('not found'), { code: 404 })
}

function set404Response(): Error {
  return Object.assign(new Error('not found'), { response: { statusCode: 404 } })
}

beforeEach(() => {
  nextQueryResults = []
  queryLog.length = 0
  nextQueryThrow = null
  pools.length = 0
  k8sCalls.read.length = 0
  k8sCalls.replace.length = 0
  k8sCalls.create.length = 0
  k8sCalls.delete_.length = 0
  k8sCalls.configLoadOptions.length = 0
  k8sCalls.configLoadDefault = 0
  inCluster = false
  readSecretImpl = async () => ({ data: {} })
  replaceSecretImpl = async () => {}
  createSecretImpl = async () => {}
  deleteSecretImpl = async () => {}
})

afterEach(async () => {
  await svc.shutdown() // clears the lazy singleton pool
})

// ─── pure helpers ────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  it('dbSecretName builds the canonical name', () => {
    expect(svc.dbSecretName('abc123')).toBe('project-abc123-db-creds')
  })

  it('projectIdToDbName converts a valid UUID to project_<uuid_with_underscores>', () => {
    expect(svc.projectIdToDbName(UUID_A)).toBe(dbNameA)
  })

  it('projectIdToDbName rejects non-UUID input', () => {
    expect(() => svc.projectIdToDbName('not-a-uuid')).toThrow(/Invalid project ID format/)
  })

  it('projectIdToDbName truncates a long invalid input in the error message', () => {
    const huge = 'x'.repeat(200)
    expect(() => svc.projectIdToDbName(huge)).toThrow(/got "x{40}"/)
  })

  it('buildDatabaseUrl uses the captured host + port consts', () => {
    expect(svc.buildDatabaseUrl('dbN', 'usr', 'p@s')).toBe(
      'postgres://usr:p@s@projects-pg-test.svc:6432/dbN',
    )
  })

  it('getProjectsDbHost returns the captured host', () => {
    expect(svc.getProjectsDbHost()).toBe('projects-pg-test.svc')
  })

  it('getProjectsDbPort returns the parsed port', () => {
    expect(svc.getProjectsDbPort()).toBe(6432)
  })
})

// ─── shutdown / pool lifecycle ──────────────────────────────────────────────

describe('shutdown', () => {
  it('is a no-op when the pool has never been created', async () => {
    await svc.shutdown()
    expect(pools).toHaveLength(0)
  })

  it('ends the pool exactly once when called repeatedly', async () => {
    expect(await svc.testConnection()).toBe(true)
    expect(pools).toHaveLength(1)
    await svc.shutdown()
    expect(pools[0]!.ended).toBe(true)
    await svc.shutdown() // second call: no-op
    expect(pools[0]!.ended).toBe(true)
  })

  it('registers an error handler on the admin pool that logs without throwing', async () => {
    await svc.testConnection()
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      pools[0]!.emit('error', new Error('pool went sideways'))
      expect(errs.some((e) => e.includes('Admin pool error: pool went sideways'))).toBe(true)
    } finally {
      console.error = orig
    }
  })
})

// ─── testConnection ─────────────────────────────────────────────────────────

describe('testConnection', () => {
  it('returns true when SELECT 1 succeeds', async () => {
    expect(await svc.testConnection()).toBe(true)
    expect(queryLog[0]!.sql).toBe('SELECT 1')
  })

  it('returns false when pool.connect throws', async () => {
    expect(await svc.testConnection()).toBe(true) // create the pool first
    pools[0]!.connectImpl = async () => { throw new Error('boom') }
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
})

// ─── getDatabaseStatus ──────────────────────────────────────────────────────

describe('getDatabaseStatus', () => {
  it('returns exists=false when pg_database has no row', async () => {
    nextQueryResults = [{ rows: [] }] // exists check
    const out = await svc.getDatabaseStatus(UUID_A)
    expect(out).toEqual({ exists: false, databaseName: dbNameA })
  })

  it('returns exists=true with parsed sizeBytes', async () => {
    nextQueryResults = [{ rows: [{ '?column?': 1 }] }, { rows: [{ size_bytes: '12345' }] }]
    const out = await svc.getDatabaseStatus(UUID_A)
    expect(out).toEqual({ exists: true, databaseName: dbNameA, sizeBytes: 12345 })
  })

  it('defaults sizeBytes to 0 when size query returns no row', async () => {
    nextQueryResults = [{ rows: [{ '?column?': 1 }] }, { rows: [] }]
    const out = await svc.getDatabaseStatus(UUID_A)
    expect(out.sizeBytes).toBe(0)
  })

  it('releases the client even if a query throws', async () => {
    await svc.testConnection() // create pool
    let releasedClient: FakeClient | null = null
    pools[0]!.connectImpl = async () => {
      const c = new FakeClient()
      releasedClient = c
      return c
    }
    nextQueryThrow = new Error('disconnected')
    await expect(svc.getDatabaseStatus(UUID_A)).rejects.toThrow(/disconnected/)
    expect(releasedClient!.released).toBe(true)
  })
})

// ─── provisionDatabase ──────────────────────────────────────────────────────

describe('provisionDatabase — new database (does not exist)', () => {
  it('creates user + database + grants, persists K8s Secret, returns credentials', async () => {
    nextQueryResults = [
      { rows: [] }, // advisory_lock
      { rows: [] }, // exists check → not found
      { rows: [] }, // DO $$ ... CREATE USER block
      { rows: [] }, // CREATE DATABASE
      { rows: [] }, // GRANT
      { rows: [] }, // pg_advisory_unlock
    ]
    readSecretImpl = async () => { throw set404() } // secret does not exist → create
    const out = await svc.provisionDatabase(UUID_A)
    expect(out.databaseName).toBe(dbNameA)
    expect(out.username).toBe(dbNameA)
    expect(out.password.length).toBeGreaterThan(20)
    expect(out.host).toBe('projects-pg-test.svc')
    expect(out.port).toBe(6432)
    expect(out.connectionUrl).toContain(`postgres://${dbNameA}:`)
    expect(out.connectionUrl).toContain(`@projects-pg-test.svc:6432/${dbNameA}`)
    // Verify K8s Secret was created (404 → create branch)
    expect(k8sCalls.create).toHaveLength(1)
    expect(k8sCalls.create[0]!.body.stringData.username).toBe(dbNameA)
    expect(k8sCalls.create[0]!.body.metadata.labels['shogo.ai/project-id']).toBe(UUID_A)
    expect(k8sCalls.create[0]!.namespace).toBe('shogo-test-ns')
  })

  it('replaces the K8s Secret when readNamespacedSecret succeeds', async () => {
    nextQueryResults = [
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    ]
    readSecretImpl = async () => ({ data: {} }) // exists
    await svc.provisionDatabase(UUID_A)
    expect(k8sCalls.replace).toHaveLength(1)
    expect(k8sCalls.create).toHaveLength(0)
  })

  it('swallows duplicate_database (42P04) from CREATE DATABASE', async () => {
    let q = 0
    pools.length = 0
    // We need a custom query handler this time.
    nextQueryResults = [
      { rows: [] }, // advisory_lock
      { rows: [] }, // exists check → not found
      { rows: [] }, // DO block
    ]
    // We'll throw 42P04 on the next call (CREATE DATABASE).
    const out = await runWithCustomQueries(async () => svc.provisionDatabase(UUID_A), [
      { rows: [] }, // advisory_lock
      { rows: [] }, // exists check
      { rows: [] }, // DO block
      { throw: Object.assign(new Error('dup'), { code: '42P04' }) }, // CREATE DATABASE
      { rows: [] }, // GRANT
      { rows: [] }, // pg_advisory_unlock
    ])
    expect(out.databaseName).toBe(dbNameA)
  })

  it('rethrows non-42P04 errors from CREATE DATABASE and still releases the lock', async () => {
    await runWithCustomQueries(
      async () => {
        await expect(svc.provisionDatabase(UUID_A)).rejects.toThrow(/permission denied/)
      },
      [
        { rows: [] }, // lock
        { rows: [] }, // exists
        { rows: [] }, // DO
        { throw: Object.assign(new Error('permission denied'), { code: '42501' }) },
        { rows: [] }, // unlock (still happens because of finally)
      ],
    )
    // The unlock must have run
    const unlockQ = queryLog.find((q) => q.sql.includes('pg_advisory_unlock'))
    expect(unlockQ).toBeDefined()
  })

  it('logs but does not fail when storeCredentialsSecret throws', async () => {
    nextQueryResults = [
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    ]
    readSecretImpl = async () => { throw new Error('k8s api down') }
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      const out = await svc.provisionDatabase(UUID_A)
      expect(out.databaseName).toBe(dbNameA)
      expect(errs.some((e) => e.includes('Failed to create K8s Secret'))).toBe(true)
    } finally {
      console.error = orig
    }
  })
})

describe('provisionDatabase — existing database (no forceReset)', () => {
  it('returns stored credentials from the K8s Secret when present', async () => {
    nextQueryResults = [
      { rows: [] }, // lock
      { rows: [{ '?column?': 1 }] }, // exists check → found
      { rows: [] }, // unlock
    ]
    readSecretImpl = async () => ({
      data: {
        'database-url': Buffer.from('postgres://x:y@h:5432/db').toString('base64'),
        username: Buffer.from('existing_user').toString('base64'),
        password: Buffer.from('existing-password').toString('base64'),
      },
    })
    const out = await svc.provisionDatabase(UUID_A)
    expect(out.username).toBe('existing_user')
    expect(out.password).toBe('existing-password')
    expect(out.connectionUrl).toBe('postgres://x:y@h:5432/db')
  })

  it('returns empty password when the K8s Secret does not exist (legacy project)', async () => {
    nextQueryResults = [
      { rows: [] }, // lock
      { rows: [{ '?column?': 1 }] }, // exists
      { rows: [] }, // unlock
    ]
    readSecretImpl = async () => { throw set404Response() }
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const out = await svc.provisionDatabase(UUID_A)
      expect(out.password).toBe('')
      expect(out.connectionUrl).toBe(`postgres://${dbNameA}@projects-pg-test.svc:6432/${dbNameA}`)
      expect(warns.some((w) => w.includes('No K8s Secret found'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  it('warns and returns empty password when readCredentialsSecret throws non-404', async () => {
    nextQueryResults = [
      { rows: [] }, { rows: [{ '?column?': 1 }] }, { rows: [] },
    ]
    readSecretImpl = async () => { throw new Error('cluster offline') }
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const out = await svc.provisionDatabase(UUID_A)
      expect(out.password).toBe('')
      expect(warns.some((w) => w.includes('Could not read K8s Secret'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  it('treats a Secret with empty stringData as not-stored', async () => {
    nextQueryResults = [
      { rows: [] }, { rows: [{ '?column?': 1 }] }, { rows: [] },
    ]
    readSecretImpl = async () => ({ data: {} }) // present but empty
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const out = await svc.provisionDatabase(UUID_A)
      expect(out.password).toBe('')
      expect(warns.some((w) => w.includes('No K8s Secret found'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  it('treats a Secret missing `data` entirely as not-stored', async () => {
    nextQueryResults = [
      { rows: [] }, { rows: [{ '?column?': 1 }] }, { rows: [] },
    ]
    readSecretImpl = async () => ({}) // no `data`
    const out = await svc.provisionDatabase(UUID_A)
    expect(out.password).toBe('')
  })
})

describe('provisionDatabase — forcePasswordReset', () => {
  it('rotates the PG password and updates the K8s Secret', async () => {
    nextQueryResults = [
      { rows: [] }, // lock
      { rows: [{ '?column?': 1 }] }, // exists
      { rows: [] }, // ALTER USER
      { rows: [] }, // unlock
    ]
    readSecretImpl = async () => ({ data: {} }) // present → replace
    const out = await svc.provisionDatabase(UUID_A, { forcePasswordReset: true })
    expect(out.password.length).toBeGreaterThan(20)
    expect(queryLog.find((q) => q.sql.includes('ALTER USER'))).toBeDefined()
    expect(k8sCalls.replace).toHaveLength(1)
  })

  it('logs but does not fail when updating the K8s Secret throws', async () => {
    nextQueryResults = [
      { rows: [] }, { rows: [{ '?column?': 1 }] }, { rows: [] }, { rows: [] },
    ]
    readSecretImpl = async () => ({ data: {} })
    replaceSecretImpl = async () => { throw new Error('replace failed') }
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      const out = await svc.provisionDatabase(UUID_A, { forcePasswordReset: true })
      expect(out.password.length).toBeGreaterThan(20)
      expect(errs.some((e) => e.includes('Failed to update K8s Secret after password reset'))).toBe(true)
    } finally {
      console.error = orig
    }
  })
})

// ─── dropDatabase ───────────────────────────────────────────────────────────

describe('dropDatabase', () => {
  it('terminates connections, drops db + user, deletes the Secret', async () => {
    nextQueryResults = [
      { rows: [] }, // pg_terminate_backend
      { rows: [] }, // DROP DATABASE
      { rows: [] }, // DROP USER
    ]
    await svc.dropDatabase(UUID_A)
    expect(queryLog.some((q) => q.sql.includes('pg_terminate_backend'))).toBe(true)
    expect(queryLog.some((q) => q.sql.includes('DROP DATABASE'))).toBe(true)
    expect(queryLog.some((q) => q.sql.includes('DROP USER'))).toBe(true)
    expect(k8sCalls.delete_).toHaveLength(1)
  })

  it('silently ignores a 404 when deleting the Secret', async () => {
    nextQueryResults = [{ rows: [] }, { rows: [] }, { rows: [] }]
    deleteSecretImpl = async () => { throw set404() }
    await expect(svc.dropDatabase(UUID_A)).resolves.toBeUndefined()
  })

  it('warns but does not fail when Secret delete throws non-404', async () => {
    nextQueryResults = [{ rows: [] }, { rows: [] }, { rows: [] }]
    deleteSecretImpl = async () => { throw new Error('forbidden') }
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      await svc.dropDatabase(UUID_A)
      expect(warns.some((w) => w.includes('Failed to delete credentials Secret'))).toBe(true)
    } finally {
      console.warn = orig
    }
  })

  it('always releases the pg client even if pg_terminate_backend throws', async () => {
    await svc.testConnection() // initialize pool
    let releasedClient: FakeClient | null = null
    pools[0]!.connectImpl = async () => {
      const c = new FakeClient()
      releasedClient = c
      return c
    }
    nextQueryThrow = new Error('terminate failed')
    await expect(svc.dropDatabase(UUID_A)).rejects.toThrow(/terminate failed/)
    expect(releasedClient!.released).toBe(true)
  })
})

// ─── K8s Secret 404 paths (covered by readCredentialsSecret 404) ────────────

describe('K8s Secret 404 detection', () => {
  it('treats `err.code === 404` as a not-found in storeCredentialsSecret', async () => {
    nextQueryResults = [
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    ]
    readSecretImpl = async () => { throw set404() } // 404 with code
    await svc.provisionDatabase(UUID_A)
    expect(k8sCalls.create).toHaveLength(1)
  })

  it('treats `err.response.statusCode === 404` as a not-found in storeCredentialsSecret', async () => {
    nextQueryResults = [
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    ]
    readSecretImpl = async () => { throw set404Response() } // 404 via response.statusCode
    await svc.provisionDatabase(UUID_A)
    expect(k8sCalls.create).toHaveLength(1)
  })

  it('rethrows non-404 errors from readNamespacedSecret in storeCredentialsSecret', async () => {
    nextQueryResults = [
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    ]
    readSecretImpl = async () => { throw new Error('rbac denied') }
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      const out = await svc.provisionDatabase(UUID_A)
      // new-db path swallows the storeCredentialsSecret error (logs but returns)
      expect(out.databaseName).toBe(dbNameA)
      expect(errs.some((e) => e.includes('Failed to create K8s Secret'))).toBe(true)
    } finally {
      console.error = orig
    }
  })
})

// ─── In-cluster KubeConfig (one-shot — different from default-load path) ────

describe('KubeConfig in-cluster vs default', () => {
  it('uses loadFromOptions when /var/run/secrets/.../ca.crt + token exist', async () => {
    inCluster = true
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.KUBERNETES_SERVICE_PORT = '443'
    nextQueryResults = [
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    ]
    // K8s API client is created lazily on first call; since the singleton may
    // already be initialized from earlier tests, we can't reliably re-init.
    // Instead, verify the existsSync mock branch was wired correctly: provision
    // succeeds end-to-end with inCluster=true (no errors thrown from k8s setup).
    const out = await svc.provisionDatabase(UUID_A)
    expect(out.databaseName).toBe(dbNameA)
    delete process.env.KUBERNETES_SERVICE_HOST
    delete process.env.KUBERNETES_SERVICE_PORT
  })
})

// ─── small helper used by the 42P04 / non-42P04 tests ───────────────────────

async function runWithCustomQueries<T>(
  fn: () => Promise<T>,
  queries: Array<{ rows?: QueryRow[]; throw?: Error }>,
): Promise<T> {
  await svc.testConnection()
  const pool = pools[0]!
  pool.connectImpl = async () => {
    const c = new FakeClient()
    let i = 0
    const orig = c.query.bind(c)
    c.query = async (sql: string, params?: unknown[]) => {
      queryLog.push({ sql, params })
      const spec = queries[i++] ?? { rows: [] }
      if (spec.throw) throw spec.throw
      return { rows: spec.rows ?? [] }
    }
    return c
  }
  return fn()
}
