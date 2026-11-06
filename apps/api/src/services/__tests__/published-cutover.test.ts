// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-308 §7 — the cutover of a metal-live published site to Knative + Postgres.
 *
 * The migration script cannot run in CI (no `published:{id}` microVMs, no
 * projects-pg), so the orchestration is where the guarantees have to be proved:
 * the maintenance window goes up before the freeze, the VM is never released
 * before the site is serving from Knative, every abort rolls the edge back to
 * `metal` and resumes the VM, a switch over budget is an abort, and a rehearsal
 * changes nothing at all.
 *
 * The archive import itself gets a real Postgres when `CHANNELS_TEST_PG_URL` is
 * set (the RBAC job provides one) and is otherwise covered by the parts that
 * need no server: unpacking a real tar, and the row-count comparison.
 */
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  countPostgresRows,
  countSqliteRows,
  copySqliteToPostgres,
  cutoverArchiveKey,
  diffRowCounts,
  extractSqliteFromArchive,
  isArchiveFresh,
  isMidCutoverStatus,
  prepareCutoverSite,
  rehearsalDatabaseName,
  rehearsalServiceName,
  rehearseCutoverSite,
  restoreSiteToMetal,
  switchCutoverSite,
  waitForFreshArchive,
  type ArchiveObject,
  type CutoverDeps,
  type CutoverEnvironment,
  type CutoverResult,
  type PreparedSite,
} from '../published-cutover.service'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = '11111111-2222-4333-8444-555555555555'
const SUBDOMAIN = 'demo'
const ENV: CutoverEnvironment = {
  id: 'env_1',
  name: 'production',
  subdomain: SUBDOMAIN,
  minReplicas: 0,
  maxReplicas: 1,
  size: 's',
  dbProvider: null,
  dbName: null,
  currentDeploymentId: null,
}

interface Harness {
  deps: CutoverDeps
  calls: string[]
  /** Fake clock: `sleep` advances it, so a budget test is deterministic. */
  clock: { t: number }
  /** When set, the next archive head returns this instead of a fresh object. */
  archive: ArchiveObject | null
  /** Edge value children read back after a flip. */
  edge: 'knative' | 'metal' | null
  healthy: boolean
  /** Phase 1's readiness result. */
  ready: boolean
  importResult: any
  cloneFailure?: string
}

function harness(overrides: Partial<CutoverDeps> = {}): Harness {
  const calls: string[] = []
  const state: Harness = {
    calls,
    clock: { t: 1_000_000 },
    archive: null,
    edge: 'metal',
    healthy: true,
    ready: true,
    importResult: { ok: true, value: { rows: 7 } },
    deps: {} as CutoverDeps,
  }
  const base: CutoverDeps = {
    now: () => state.clock.t,
    // Time moves only when something sleeps, which is what makes "the window ran
    // out of budget" a fact about the code rather than about the machine.
    sleep: async (ms) => {
      state.clock.t += ms
    },
    log: () => {},
    async ensureEnvironment() {
      calls.push('ensureEnvironment')
      return ENV
    },
    async prepareDatabase() {
      calls.push('prepareDatabase')
      return { ok: true, value: { databaseName: 'project_x', directUrl: 'postgres://direct/x' } }
    },
    async ensureImage() {
      calls.push('ensureImage')
      return { ok: true, value: { imageRef: 'repo@sha256:abc', imageDigest: 'sha256:abc', reused: true } }
    },
    async ensureWarmService(_site, opts) {
      calls.push(`ensureWarmService:${opts.serviceName ?? 'production'}:min=${opts.minScale}`)
    },
    async deleteService(_site, name) {
      calls.push(`deleteService:${name}`)
    },
    async healthCheck(_site, opts) {
      calls.push(`healthCheck:${opts?.serviceName ?? 'production'}`)
      return state.healthy
    },
    async waitForServiceReady(_site, opts) {
      calls.push(`waitForServiceReady:${opts.serviceName ?? 'production'}:timeout=${opts.timeoutMs}`)
      return state.ready
    },
    async markDatabaseLocal(_site, envId) {
      calls.push(`markDatabaseLocal:${envId}`)
    },
    async headArchive() {
      calls.push('headArchive')
      return state.archive
    },
    async downloadArchive() {
      calls.push('downloadArchive')
      return Buffer.from('archive')
    },
    async freezeMetal() {
      calls.push('freezeMetal')
      // A host that exports during the freeze is the normal case.
      if (!state.archive) {
        state.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 42, lastModifiedMs: Date.now() }
      }
    },
    async resumeMetal() {
      calls.push('resumeMetal')
    },
    async releaseMetal() {
      calls.push('releaseMetal')
    },
    async readEdgeBackend() {
      return state.edge
    },
    async setEdgeBackend(_subdomain, backend) {
      calls.push(`setEdgeBackend:${backend}`)
      state.edge = backend
      return true
    },
    async setMaintenance(_site, _envId, on, detail) {
      calls.push(`setMaintenance:${on ? 'on' : `off${detail ? ':error' : ''}`}`)
    },
    async cloneDatabase(_source, target) {
      calls.push(`cloneDatabase:${target}`)
      if (state.cloneFailure) throw new Error(state.cloneFailure)
      return { directUrl: 'postgres://direct/rehearsal' }
    },
    async dropClone(target) {
      calls.push(`dropClone:${target}`)
    },
    async countPostgres() {
      return new Map<string, number>()
    },
    async recordDeployment() {
      calls.push('recordDeployment')
    },
    async importArchive() {
      calls.push('importArchive')
      return state.importResult
    },
  }
  state.deps = { ...base, ...overrides }
  return state
}

async function preparedSite(deps: CutoverDeps): Promise<PreparedSite> {
  const prepared = await prepareCutoverSite({ projectId: PROJECT_ID, subdomain: SUBDOMAIN }, deps)
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.message}`)
  return prepared.value
}

const SITE = { projectId: PROJECT_ID, subdomain: SUBDOMAIN }

/** Build a real tar.gz with the system tar, so the reader is not tested against itself. */
async function makeArchive(dir: string, files: string[]): Promise<Buffer> {
  const out = join(dir, 'data.tar.gz')
  const proc = Bun.spawn(['tar', '-czf', out, '-C', dir, ...files], { stdout: 'pipe', stderr: 'pipe' })
  if ((await proc.exited) !== 0) throw new Error(`tar failed: ${await new Response(proc.stderr).text()}`)
  return Buffer.from(await readFile(out))
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('isMidCutoverStatus', () => {
  it('recognises the status the switch writes', () => {
    expect(isMidCutoverStatus('switching')).toBe(true)
    // The row's value comes from Prisma/Postgres and is case-preserving.
    expect(isMidCutoverStatus('SWITCHING')).toBe(true)
  })

  it('is false for every other status, and for a site with none', () => {
    for (const status of ['live', 'failed', 'building', 'uploading', '']) {
      expect(isMidCutoverStatus(status)).toBe(false)
    }
    expect(isMidCutoverStatus(null)).toBe(false)
    expect(isMidCutoverStatus(undefined)).toBe(false)
  })

  it('never widens to a substring: a status that merely contains it stays live', () => {
    expect(isMidCutoverStatus('not-switching')).toBe(false)
    expect(isMidCutoverStatus('switching-soon')).toBe(false)
  })
})

describe('diffRowCounts', () => {
  it('passes when every table matches', () => {
    const sqlite = new Map([['User', 2], ['Post', 3]])
    expect(diffRowCounts(sqlite, new Map([['User', 2], ['Post', 3]]))).toEqual([])
  })

  it('reports a differing count with both sides', () => {
    const sqlite = new Map([['User', 2]])
    expect(diffRowCounts(sqlite, new Map([['User', 1]]))).toEqual([
      { table: 'User', sqlite: 2, postgres: 1, reason: 'count' },
    ])
  })

  it('reports a table Postgres never got as missing, not as zero rows', () => {
    const sqlite = new Map([['Post', 3]])
    const mismatches = diffRowCounts(sqlite, new Map([['Post', -1]]))
    expect(mismatches).toEqual([{ table: 'Post', sqlite: 3, postgres: -1, reason: 'missing_table' }])
  })
})

describe('waitForFreshArchive', () => {
  it('accepts an archive written during the freeze', async () => {
    const archive: ArchiveObject = { key: 'demo/data.tar.gz', bytes: 1, lastModifiedMs: 10_000 }
    expect(isArchiveFresh(archive, 9_000)).toBe(true)
  })

  it('rejects the pre-freeze archive: importing it would drop the last writes', () => {
    const stale: ArchiveObject = { key: 'demo/data.tar.gz', bytes: 1, lastModifiedMs: 1_000 }
    expect(isArchiveFresh(stale, 60_000)).toBe(false)
  })

  it('allows a few seconds of clock slack between the freeze and the object write', () => {
    const archive: ArchiveObject = { key: 'k', bytes: 1, lastModifiedMs: 58_000 }
    expect(isArchiveFresh(archive, 60_000)).toBe(true)
    expect(isArchiveFresh(archive, 60_000, 500)).toBe(false)
  })

  it('polls until a fresh archive appears', async () => {
    let now = 0
    let calls = 0
    const fresh: ArchiveObject = { key: 'k', bytes: 1, lastModifiedMs: 5_000 }
    const result = await waitForFreshArchive({
      head: async () => (++calls >= 3 ? fresh : null),
      frozenAtMs: 5_000,
      timeoutMs: 1_000,
      intervalMs: 10,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    expect(result).toBe(fresh)
    expect(calls).toBe(3)
  })

  it('returns null when the deadline passes, so the switch aborts', async () => {
    let now = 0
    const result = await waitForFreshArchive({
      head: async () => ({ key: 'k', bytes: 1, lastModifiedMs: 0 }),
      frozenAtMs: 60_000,
      timeoutMs: 100,
      intervalMs: 10,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    expect(result).toBeNull()
  })
})

describe('extractSqliteFromArchive', () => {
  it('unpacks a real data.tar.gz and finds prisma/dev.db', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shogo-cut-test-'))
    try {
      await mkdir(join(dir, 'prisma'), { recursive: true })
      const db = new Database(join(dir, 'prisma', 'dev.db'))
      db.exec('CREATE TABLE "User" (id INTEGER PRIMARY KEY, name TEXT)')
      db.exec(`INSERT INTO "User" (name) VALUES ('ada'), ('grace')`)
      db.close()
      const extracted = await extractSqliteFromArchive(await makeArchive(dir, ['prisma/dev.db']))
      try {
        expect(extracted.sqlitePath.endsWith('prisma/dev.db')).toBe(true)
        expect(countSqliteRows(extracted.sqlitePath)).toEqual(new Map([['User', 2]]))
      } finally {
        await extracted.cleanup()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails loudly when the archive carries no database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shogo-cut-test-'))
    try {
      await writeFile(join(dir, 'readme.txt'), 'nothing here')
      await expect(extractSqliteFromArchive(await makeArchive(dir, ['readme.txt']))).rejects.toThrow(/prisma\/dev\.db/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// phase 1
// ---------------------------------------------------------------------------

describe('prepareCutoverSite', () => {
  it('provisions, builds and warms a ksvc without giving it traffic', async () => {
    const h = harness()
    const prepared = await preparedSite(h.deps)
    expect(prepared.database.directUrl).toBe('postgres://direct/x')
    expect(prepared.image.imageRef).toBe('repo@sha256:abc')
    expect(h.calls).toEqual([
      'ensureEnvironment',
      'prepareDatabase',
      'ensureImage',
      'ensureWarmService:production:min=1',
      'waitForServiceReady:production:timeout=300000',
    ])
    // Nothing here may flip the edge or touch the metal runtime: the site keeps
    // serving from metal until phase 2.
    expect(h.calls.some((c) => c.startsWith('setEdgeBackend'))).toBe(false)
    expect(h.calls).not.toContain('freezeMetal')
  })

  // Round-16 blocker 1: POSTing the ksvc is not having a pod. The image pull and
  // the init-container's S3 sync happen on the first start, and if phase 1 does
  // not wait for them they land inside the downtime window.
  it('waits for the ksvc to be Ready, so the cold start is not part of the window', async () => {
    const h = harness()
    h.deps.waitForServiceReady = async (_site, opts) => {
      h.calls.push(`waitForServiceReady:${opts.timeoutMs}`)
      // A realistic first start: two minutes of pull + init container.
      h.clock.t += 120_000
      return true
    }
    const prepared = await preparedSite(h.deps)

    const warm = h.calls.indexOf('ensureWarmService:production:min=1')
    const ready = h.calls.findIndex((c) => c.startsWith('waitForServiceReady'))
    expect(warm).toBeGreaterThanOrEqual(0)
    expect(ready).toBeGreaterThan(warm)
    // The wait is phase 1's cost, and phase 1 is what `prepareMs` measures.
    expect(prepared.prepareMs).toBeGreaterThanOrEqual(120_000)
  })

  it('refuses to hand the switch a ksvc that never became ready', async () => {
    const h = harness()
    h.ready = false
    const result = await prepareCutoverSite(SITE, h.deps, { readinessTimeoutMs: 30_000 })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('prepare_not_ready')
      expect(result.message).toContain('30s')
      expect(result.message).toContain('untouched on metal')
    }
    // A switch must never be attempted on a cold revision.
    expect(h.calls).not.toContain('setMaintenance:on')
    expect(h.calls).not.toContain('freezeMetal')
  })

  it('stops before warming a service when the database cannot be prepared', async () => {
    const h = harness({
      prepareDatabase: async () => ({ ok: false, code: 'database_unavailable', message: 'no pooler' }),
    })
    const result = await prepareCutoverSite(SITE, h.deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('database_unavailable')
    expect(h.calls).toEqual(['ensureEnvironment'])
  })

  it('stops when the image cannot be built, rather than booting the shared image', async () => {
    const h = harness({
      ensureImage: async () => ({ ok: false, code: 'build_failed', message: 'buildkit exited 1' }),
    })
    const result = await prepareCutoverSite(SITE, h.deps)
    expect(result.ok).toBe(false)
    expect(h.calls).not.toContain('ensureWarmService:production:min=1')
    expect(h.calls.some((c) => c.startsWith('waitForServiceReady'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// phase 2
// ---------------------------------------------------------------------------

const BUDGET = { maxDowntimeMs: 60_000, archiveTimeoutMs: 500 }

describe('switchCutoverSite', () => {
  it('freezes, imports, proves the ksvc serves, flips the edge and only then releases the VM', async () => {
    const h = harness()
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    const result = await switchCutoverSite(prepared, h.deps, BUDGET)

    expect(result.outcome).toBe('migrated')
    expect(h.calls).toEqual([
      'setMaintenance:on',
      'freezeMetal',
      'headArchive',
      'downloadArchive',
      'importArchive',
      // Ready BEFORE the edge points at it: a cold or crash-looping pod costs no
      // visitor a write.
      'healthCheck:production',
      'setEdgeBackend:knative',
      'healthCheck:production',
      'setMaintenance:off',
      'recordDeployment',
      'releaseMetal',
    ])
  })

  it('truncates and imports into the primary, never the pooler', async () => {
    const h = harness()
    const prepared = await preparedSite(h.deps)
    let seen: { url: string; truncate: boolean } | null = null
    h.deps.importArchive = async (_archive, url, opts) => {
      seen = { url, truncate: opts.truncate }
      return { ok: true, value: { rows: 3 } }
    }
    await switchCutoverSite(prepared, h.deps, BUDGET)
    expect(seen).toEqual({ url: 'postgres://direct/x', truncate: true })
  })

  it('aborts before flipping the edge when no fresh export arrives', async () => {
    const h = harness({
      freezeMetal: async () => {
        h.calls.push('freezeMetal')
        // No archive written during the freeze: the pre-freeze one is stale.
        h.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 9, lastModifiedMs: 0 }
      },
      now: (() => {
        let t = 1_000_000
        return () => (t += 1_000)
      })(),
    })
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    const result: CutoverResult = await switchCutoverSite(prepared, h.deps, BUDGET)

    expect(result.outcome).toBe('rolled-back')
    expect(result.code).toBe('archive_not_exported')
    expect(h.calls).toContain('setEdgeBackend:metal')
    expect(h.calls).toContain('resumeMetal')
    expect(h.calls).not.toContain('setEdgeBackend:knative')
    expect(h.calls).not.toContain('importArchive')
    // The maintenance window must never be left on: the site is live again.
    expect(h.calls).toContain('setMaintenance:off:error')
  })

  it('aborts on a row-count mismatch, with the affected tables', async () => {
    const h = harness()
    h.importResult = {
      ok: false,
      code: 'row_count_mismatch',
      message: 'Row counts differ after the load (1 table(s)): User 2→1',
      mismatches: [{ table: 'User', sqlite: 2, postgres: 1, reason: 'count' as const }],
    }
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    const result = await switchCutoverSite(prepared, h.deps, BUDGET)

    expect(result.outcome).toBe('rolled-back')
    expect(result.code).toBe('row_count_mismatch')
    expect(result.mismatches).toEqual([{ table: 'User', sqlite: 2, postgres: 1, reason: 'count' }])
    expect(h.calls).not.toContain('setEdgeBackend:knative')
    expect(h.calls).toContain('resumeMetal')
  })

  it('never flips the edge to a service that does not answer before the window ends', async () => {
    const h = harness()
    h.healthy = false
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    const result = await switchCutoverSite(prepared, h.deps, BUDGET)

    expect(result.outcome).toBe('rolled-back')
    // A pod that never comes up spends the budget: that IS the amount of downtime
    // the site took, so it is reported as such rather than as a bare health error.
    expect(result.code).toBe('over_downtime_budget')
    // The edge never pointed at it, so no visitor write was served and discarded.
    expect(h.calls).not.toContain('setEdgeBackend:knative')
    expect(h.calls).toContain('setEdgeBackend:metal')
    expect(h.calls).toContain('resumeMetal')
    expect(h.calls).not.toContain('releaseMetal')
    expect(h.calls).toContain('setMaintenance:off:error')
  })

  // Round-16 blocker 2: the budget has to bound the wait, not judge it afterwards.
  it('bounds the readiness wait by the budget instead of polling on past it', async () => {
    const h = harness()
    h.healthy = false
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    const result = await switchCutoverSite(prepared, h.deps, { maxDowntimeMs: 20_000, archiveTimeoutMs: 500 })

    expect(result.code).toBe('over_downtime_budget')
    const probes = h.calls.filter((c) => c === 'healthCheck:production').length
    // 20s budget at 1.5s between probes: nowhere near the old 20-probe loop that
    // could run ~130s regardless of the budget.
    expect(probes).toBeLessThanOrEqual(14)
    expect(result.downtimeMs).toBeLessThan(20_000 + 5_000)
  })

  it('checks the budget BEFORE the window closes, so an over-budget switch never serves traffic', async () => {
    const h = harness()
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    // Healthy, and every clock read jumps 30s: the confirm succeeds but the window
    // is already past a 10s budget when it is measured.
    let t = 0
    h.deps.now = () => (t += 30_000)
    h.deps.healthCheck = async (_site, opts) => {
      h.calls.push(`healthCheck:${opts?.serviceName ?? 'production'}`)
      return true
    }
    const result = await switchCutoverSite(prepared, h.deps, { maxDowntimeMs: 10_000, archiveTimeoutMs: 500 })

    expect(result.outcome).toBe('rolled-back')
    expect(result.code).toBe('over_downtime_budget')
    // The only maintenance-off is the rollback's, carrying the reason: there is no
    // successful close, so the site was never handed to visitors and then pulled.
    expect(h.calls).not.toContain('setMaintenance:off')
    expect(h.calls).toContain('setMaintenance:off:error')
    expect(h.calls).toContain('setEdgeBackend:metal')
    expect(h.calls).not.toContain('releaseMetal')
  })

  it('rolls back when the routed service stops answering after the flip', async () => {
    const h = harness()
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    // Ready before the flip, silent after it — the case the confirm probe exists for.
    let probes = 0
    h.deps.healthCheck = async (_site, opts) => {
      h.calls.push(`healthCheck:${opts?.serviceName ?? 'production'}`)
      probes++
      return probes === 1
    }
    const result = await switchCutoverSite(prepared, h.deps, BUDGET)

    expect(result.outcome).toBe('rolled-back')
    expect(result.code).toBe('health_check_failed')
    expect(h.calls).toContain('setEdgeBackend:knative')
    expect(h.calls).toContain('setEdgeBackend:metal')
    expect(h.calls).not.toContain('releaseMetal')
  })

  it('treats a switch over the downtime budget as a failure and rolls back', async () => {
    const h = harness()
    // Every clock read advances 10s: the window cannot fit a 1s budget.
    let t = 0
    h.deps.now = () => (t += 10_000)
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    const result = await switchCutoverSite(prepared, h.deps, { maxDowntimeMs: 1_000, archiveTimeoutMs: 500 })

    expect(result.outcome).toBe('rolled-back')
    expect(result.code).toBe('over_downtime_budget')
    expect(h.calls).toContain('setEdgeBackend:metal')
    expect(h.calls).toContain('resumeMetal')
    expect(h.calls).not.toContain('releaseMetal')
  })

  it('rolls back when the edge flag will not flip', async () => {
    const h = harness()
    h.deps.setEdgeBackend = async (_subdomain, backend) => {
      h.calls.push(`setEdgeBackend:${backend}`)
      return backend === 'metal'
    }
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    const result = await switchCutoverSite(prepared, h.deps, BUDGET)
    expect(result.outcome).toBe('rolled-back')
    expect(result.code).toBe('edge_flip_failed')
    expect(h.calls).toContain('resumeMetal')
  })
})

// ---------------------------------------------------------------------------
// rehearsal
// ---------------------------------------------------------------------------

describe('rehearseCutoverSite', () => {
  it('measures against a copy: no freeze, no flip, and the copies are cleaned up', async () => {
    const h = harness()
    const prepared = await preparedSite(h.deps)
    h.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 12, lastModifiedMs: Date.now() }
    h.calls.length = 0
    const result = await rehearseCutoverSite(prepared, h.deps, { archiveTimeoutMs: 500 })

    expect(result.outcome).toBe('rehearsed')
    const scratch = rehearsalDatabaseName('project_x')
    expect(h.calls).toEqual([
      // Warm and Ready BEFORE anything is timed: that start is phase 1's cost in a
      // real switch, and counting it here would inflate the number this exists for.
      `ensureWarmService:${rehearsalServiceName(PROJECT_ID)}:min=1`,
      `waitForServiceReady:${rehearsalServiceName(PROJECT_ID)}:timeout=300000`,
      'headArchive',
      'downloadArchive',
      `cloneDatabase:${scratch}`,
      'importArchive',
      `healthCheck:${rehearsalServiceName(PROJECT_ID)}`,
      `deleteService:${rehearsalServiceName(PROJECT_ID)}`,
      `dropClone:${scratch}`,
    ])

    // The claims that matter: nothing was frozen, nothing was routed, nothing
    // was released.
    expect(h.calls).not.toContain('freezeMetal')
    expect(h.calls).not.toContain('setEdgeBackend:knative')
    expect(h.calls).not.toContain('releaseMetal')
    expect(h.calls).not.toContain('resumeMetal')
    expect(h.calls).not.toContain('setMaintenance:on')
  })

  it('fails when the rehearsal service never becomes ready, and still cleans up', async () => {
    const h = harness()
    h.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 12, lastModifiedMs: Date.now() }
    const prepared = await preparedSite(h.deps)
    // Phase 1's ksvc was warm; the rehearsal service is the one that never comes up.
    h.deps.waitForServiceReady = async () => false
    h.calls.length = 0
    const result = await rehearseCutoverSite(prepared, h.deps, { readinessTimeoutMs: 30_000 })
    expect(result.outcome).toBe('failed')
    expect(result.code).toBe('health_check_failed')
    // Nothing was timed, because nothing could have served.
    expect(result.downtimeMs).toBeNull()
    expect(h.calls).not.toContain('importArchive')
    expect(h.calls).toContain(`deleteService:${rehearsalServiceName(PROJECT_ID)}`)
    // No copy was ever made, so there is none to drop — and the service is gone.
    expect(h.calls).not.toContain(`dropClone:${rehearsalDatabaseName('project_x')}`)
  })

  it('does not count the warm-up in the reported downtime', async () => {
    const h = harness()
    h.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 12, lastModifiedMs: Date.now() }
    h.deps.waitForServiceReady = async () => {
      // A cold first start, exactly what production pays in phase 1.
      h.clock.t += 180_000
      return true
    }
    const prepared = await preparedSite(h.deps)
    const result = await rehearseCutoverSite(prepared, h.deps)
    expect(result.outcome).toBe('rehearsed')
    // The number the prod decision rests on is the copy, not the cold start.
    expect(result.downtimeMs).toBeLessThan(5_000)
  })

  it('fails when the load leaves the warmed service unable to answer', async () => {
    const h = harness()
    h.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 12, lastModifiedMs: Date.now() }
    const prepared = await preparedSite(h.deps)
    h.calls.length = 0
    h.deps.healthCheck = async () => false
    const result = await rehearseCutoverSite(prepared, h.deps)
    expect(result.outcome).toBe('failed')
    expect(result.code).toBe('health_check_failed')
    expect(result.message).toContain('after the load')
    expect(h.calls).toContain(`dropClone:${rehearsalDatabaseName('project_x')}`)
  })

  it('reports a rehearsal that flipped the edge as a failure', async () => {
    const h = harness()
    h.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 12, lastModifiedMs: Date.now() }
    h.edge = 'knative'
    const prepared = await preparedSite(h.deps)
    const result = await rehearseCutoverSite(prepared, h.deps, { archiveTimeoutMs: 500 })
    expect(result.outcome).toBe('failed')
    expect(result.code).toBe('rehearsal_flipped_edge')
  })

  it('fails when the archive cannot be copied (a busy template)', async () => {
    const h = harness()
    h.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 12, lastModifiedMs: Date.now() }
    h.cloneFailure = 'template_busy: "project_x" still has open sessions'
    const prepared = await preparedSite(h.deps)
    const result = await rehearseCutoverSite(prepared, h.deps)
    expect(result.outcome).toBe('failed')
    expect(result.code).toBe('rehearsal_failed')
    expect(result.message).toContain('template_busy')
  })

  it('refuses to rehearse a site with no archive', async () => {
    const h = harness()
    const prepared = await preparedSite(h.deps)
    const result = await rehearseCutoverSite(prepared, h.deps)
    expect(result.outcome).toBe('failed')
    expect(result.code).toBe('no_archive')
  })
})

// ---------------------------------------------------------------------------
// rollback direction
// ---------------------------------------------------------------------------

describe('restoreSiteToMetal', () => {
  it('flips the edge back to metal and resumes the runtime', async () => {
    const h = harness()
    h.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 5, lastModifiedMs: Date.now() }
    h.edge = 'knative'
    const result = await restoreSiteToMetal(SITE, h.deps)
    expect(result.outcome).toBe('restored')
    expect(h.calls).toEqual([
      'headArchive',
      'setEdgeBackend:metal',
      'resumeMetal',
      'ensureEnvironment',
      'markDatabaseLocal:env_1',
      'healthCheck:production',
    ])
  })

  // The site is on SQLite again. `dbProvider` is what `publishedLocalStateReason()`
  // reads to allow more than one replica, and local SQLite must never pass it.
  it('clears dbProvider so a restored site cannot be scaled past one replica', async () => {
    const h = harness({ ensureEnvironment: async () => ({ ...ENV, dbProvider: 'postgres' }) })
    h.archive = { key: cutoverArchiveKey(SUBDOMAIN), bytes: 5, lastModifiedMs: Date.now() }
    h.edge = 'knative'
    await restoreSiteToMetal(SITE, h.deps)
    expect(h.calls).toContain('markDatabaseLocal:env_1')
  })

  it('refuses when there is no archive to restore from', async () => {
    const h = harness()
    const result = await restoreSiteToMetal(SITE, h.deps)
    expect(result.outcome).toBe('failed')
    expect(result.code).toBe('no_archive')
    // Pointing the edge at a runtime with no data would serve an empty app.
    expect(h.calls).not.toContain('setEdgeBackend:metal')
  })
})

// ---------------------------------------------------------------------------
// the real import (needs a Postgres server)
// ---------------------------------------------------------------------------

const PG_SERVER_URL = process.env.CHANNELS_TEST_PG_URL

describe('copySqliteToPostgres (real Postgres)', () => {
  const created: string[] = []

  afterAll(async () => {
    if (!PG_SERVER_URL || created.length === 0) return
    const { Client } = await import('pg')
    const admin = new Client({ connectionString: PG_SERVER_URL })
    await admin.connect()
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => {})
    await admin.end()
  })

  it.skipIf(!PG_SERVER_URL)('loads FK-ordered rows, resets sequences and is safe to re-run', async () => {
    const { Client } = await import('pg')
    const dbName = `shogo_cutover_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const admin = new Client({ connectionString: PG_SERVER_URL })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    created.push(dbName)
    await admin.end()

    const url = new URL(PG_SERVER_URL!)
    url.pathname = `/${dbName}`
    const databaseUrl = url.toString()

    // A Prisma-shaped schema: a serial id, a Boolean (which Prisma stores as 0/1
    // in SQLite) and a foreign key.
    const { Pool } = await import('pg')
    const pgPool = new Pool({ connectionString: databaseUrl })
    await pgPool.query(`CREATE TABLE "User" (id SERIAL PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true)`)
    await pgPool.query(`CREATE TABLE "Post" (id SERIAL PRIMARY KEY, title TEXT NOT NULL, "authorId" INTEGER NOT NULL REFERENCES "User"(id))`)
    await pgPool.end()

    const dir = await mkdtemp(join(tmpdir(), 'shogo-cut-pg-'))
    try {
      const sqlitePath = join(dir, 'dev.db')
      const sqlite = new Database(sqlitePath)
      sqlite.exec(`CREATE TABLE "User" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT 1)`)
      sqlite.exec(`CREATE TABLE "Post" (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, "authorId" INTEGER NOT NULL REFERENCES "User"(id))`)
      sqlite.exec(`INSERT INTO "User" (name, active) VALUES ('ada', 1), ('grace', 0)`)
      sqlite.exec(`INSERT INTO "Post" (title, "authorId") VALUES ('one', 1), ('two', 2)`)
      sqlite.close()

      const copies = await copySqliteToPostgres(sqlitePath, databaseUrl, { truncate: true })
      expect(copies).toEqual(
        expect.arrayContaining([
          { table: 'User', rows: 2 },
          { table: 'Post', rows: 2 },
        ]),
      )

      const counts = await countPostgresRows(databaseUrl, ['User', 'Post'])
      expect(diffRowCounts(countSqliteRows(sqlitePath), counts)).toEqual([])

      // Sequence reset: the next insert must not collide with a copied id.
      const pool = new Pool({ connectionString: databaseUrl })
      const inserted = await pool.query(`INSERT INTO "User" (name, active) VALUES ('linus', true) RETURNING id, active`)
      expect(inserted.rows[0].id).toBe(3)
      // Booleans arrive as booleans, not as SQLite's 0/1 integers.
      const rows = await pool.query(`SELECT name, active FROM "User" ORDER BY id`)
      expect(rows.rows.map((r: any) => r.active)).toEqual([true, false, true])
      await pool.end()

      // Re-running with truncate replaces rather than duplicates.
      await copySqliteToPostgres(sqlitePath, databaseUrl, { truncate: true })
      const after = await countPostgresRows(databaseUrl, ['User', 'Post'])
      expect(after.get('User')).toBe(2)
      expect(after.get('Post')).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
