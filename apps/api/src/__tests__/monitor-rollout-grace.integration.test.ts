// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runs the real monitor CronJob scripts, extracted from their manifests:
 *
 *  - replication-monitor (k8s/cnpg/logical-replication/replication-monitor.yaml)
 *    against a real Postgres with real `psql`. 2026-10-16: a 01:53 migration
 *    created tables that deploy.yml published a few minutes later, and the
 *    monitor paged twice in between.
 *  - warm-pool-monitor (k8s/base/warm-pool-monitor.yaml) with real `sh` + `jq`
 *    and a `kubectl` stub serving fixture JSON. 2026-10-17: it paged three
 *    times during routine rollouts (two studio revisions Ready while the old
 *    one drained; a freshly rotated warm pool not Ready yet).
 *
 * Both must stay quiet inside the rollout window and still page once the state
 * outlives it.
 *
 *   MONITOR_TEST_PG_URL=postgres://... bun test src/__tests__/monitor-rollout-grace.integration.test.ts
 *
 * The Postgres half is skipped without a reachable Postgres or `psql`; the
 * warm-pool half is skipped without `jq`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Client } from 'pg'
import { parseAllDocuments } from 'yaml'

const REPO = resolve(import.meta.dir, '../../../..')

function cronJobScript(manifest: string): string {
  for (const doc of parseAllDocuments(readFileSync(join(REPO, manifest), 'utf8'))) {
    const obj = doc.toJS() as any
    if (obj?.kind === 'CronJob') {
      const cmd: string[] = obj.spec.jobTemplate.spec.template.spec.containers[0].command
      return cmd[cmd.length - 1]
    }
  }
  throw new Error(`no CronJob in ${manifest}`)
}

async function runScript(script: string, env: Record<string, string>) {
  const proc = Bun.spawn(['/bin/sh', '-ec', script], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const u = new URL(url)
    return await new Promise<boolean>((done) => {
      const sock = new Socket()
      const finish = (ok: boolean) => {
        sock.destroy()
        done(ok)
      }
      sock.setTimeout(500)
      sock.once('connect', () => finish(true))
      sock.once('error', () => finish(false))
      sock.once('timeout', () => finish(false))
      sock.connect(parseInt(u.port || '5432', 10), u.hostname)
    })
  } catch {
    return false
  }
}

const PG_URL =
  process.env.MONITOR_TEST_PG_URL ??
  process.env.CHANNELS_TEST_PG_URL ??
  'postgres://shogo:shogo@127.0.0.1:5432/shogo'
const PSQL =
  Bun.which('psql') ??
  ['/opt/homebrew/opt/libpq/bin/psql', '/usr/local/opt/libpq/bin/psql'].find((p) => existsSync(p)) ??
  null
const pgUp = PSQL !== null && (await reachable(PG_URL))
const JQ = Bun.which('jq')
if (process.env.REQUIRE_PG_INTEGRATION === '1' && (!pgUp || !JQ)) {
  throw new Error(`REQUIRE_PG_INTEGRATION=1 but psql=${PSQL} reachable=${pgUp} jq=${JQ} (${PG_URL})`)
}

describe.skipIf(!pgUp)('replication-monitor: migration grace window (real Postgres)', () => {
  const script = cronJobScript('k8s/cnpg/logical-replication/replication-monitor.yaml')
  const dbName = `replmon_it_${process.pid}`
  let admin: Client
  let db: Client
  let env: Record<string, string>

  /** Backdate (or not) the newest local migration. */
  async function migratedMinutesAgo(minutes: number) {
    await db.query('DELETE FROM _prisma_migrations')
    await db.query(
      `INSERT INTO _prisma_migrations (id, migration_name, finished_at)
       VALUES ('m1', '20261015005021_add_work_boards', now() - make_interval(mins => $1::int))`,
      [minutes],
    )
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL })
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`)
    await admin.query(`CREATE DATABASE ${dbName}`)
    const u = new URL(PG_URL)
    u.pathname = `/${dbName}`
    db = new Client({ connectionString: u.toString() })
    await db.connect()
    // The minimum the monitor inspects: _prisma_migrations with its
    // REPLICA-mode trigger, a published table and the publication.
    await db.query(`
      CREATE TABLE _prisma_migrations (id text PRIMARY KEY, migration_name text NOT NULL, finished_at timestamptz);
      CREATE FUNCTION skip_replicated_migrations() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER skip_replicated_migrations_trg BEFORE INSERT ON _prisma_migrations
        FOR EACH ROW EXECUTE FUNCTION skip_replicated_migrations();
      ALTER TABLE _prisma_migrations ENABLE REPLICA TRIGGER skip_replicated_migrations_trg;
      CREATE TABLE projects (id text PRIMARY KEY);
      CREATE PUBLICATION shogo_all_pub FOR TABLE projects;
    `)
    env = {
      PATH: `${dirname(PSQL!)}:${process.env.PATH}`,
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: dbName,
    }
  })

  afterAll(async () => {
    await db?.query('DROP SUBSCRIPTION IF EXISTS sub_from_eu').catch(() => {})
    await db?.end().catch(() => {})
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
    await admin?.end().catch(() => {})
  })

  test('healthy: every table published, exit 0, no warning', async () => {
    await migratedMinutesAgo(120)
    const r = await runScript(script, env)
    expect(r.out).toContain('Monitor complete (exit=0)')
    expect(r.out).not.toContain('missing from publication')
    expect(r.code).toBe(0)
  })

  test('a table a migration just created only warns until the deploy publishes it', async () => {
    await db.query('CREATE TABLE work_boards (id text PRIMARY KEY)')
    await migratedMinutesAgo(2)
    const r = await runScript(script, env)
    expect(r.out).toContain('WARNING (migration in the last 20m')
    expect(r.out).toContain('1 table(s) missing from publication!')
    expect(r.out).toContain('work_boards')
    expect(r.out).not.toContain('CRITICAL')
    expect(r.code).toBe(0)
  })

  test('the same table still pages once the grace window has passed', async () => {
    await migratedMinutesAgo(45)
    const r = await runScript(script, env)
    expect(r.out).toContain('CRITICAL: 1 table(s) missing from publication!')
    expect(r.code).toBe(1)
  })

  test('the grace window is configurable via MIGRATION_GRACE_MIN', async () => {
    await migratedMinutesAgo(45)
    const r = await runScript(script, { ...env, MIGRATION_GRACE_MIN: '60' })
    expect(r.out).toContain('WARNING (migration in the last 60m')
    expect(r.code).toBe(0)
    await db.query('ALTER PUBLICATION shogo_all_pub ADD TABLE work_boards')
  })

  test('a subscription trailing the publication warns in the window and pages after it', async () => {
    // A subscription that never connects: its pg_subscription_rel is empty, so
    // it trails the publication. Being disabled it also trips the
    // STOPPED/DISABLED checks; only the staleness line is under test here.
    await db.query(
      `CREATE SUBSCRIPTION sub_from_eu CONNECTION 'host=127.0.0.1 port=1 dbname=none'
       PUBLICATION shogo_all_pub WITH (connect = false, enabled = false, create_slot = false, slot_name = NONE)`,
    )
    await migratedMinutesAgo(2)
    let r = await runScript(script, env)
    expect(r.out).toContain('WARNING (migration in the last 20m; deploy publishes/refreshes next): subscription(s) trail')
    expect(r.out).not.toContain('CRITICAL: subscription(s) trail')

    await migratedMinutesAgo(45)
    r = await runScript(script, env)
    expect(r.out).toContain('CRITICAL: subscription(s) trail the local publication by 1+ tables.')
  })
})

describe.skipIf(!JQ)('warm-pool-monitor: rollout grace window (real sh + jq, stub kubectl)', () => {
  const script = cronJobScript('k8s/base/warm-pool-monitor.yaml')
  let dir: string

  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const ready = (ok: boolean) => [{ type: 'Ready', status: ok ? 'True' : 'False' }]

  interface Cluster {
    warmPool: Array<{ name: string; createdMinAgo: number; ready: boolean }>
    studio: Array<{ revision: string; createdMinAgo: number; ready: boolean }>
  }

  function writeCluster(c: Cluster) {
    const files: Record<string, unknown> = {
      'api-ksvc.json': { spec: { template: { spec: { containers: [{ env: [{ name: 'RUNTIME_IMAGE', value: 'ocir/runtime:abc' }] }] } } } },
      'wp-pods.json': { items: [] },
      'wp-ksvcs.json': {
        items: c.warmPool.map((k) => ({
          metadata: { name: k.name, creationTimestamp: ago(k.createdMinAgo) },
          status: { conditions: ready(k.ready) },
        })),
      },
      'nodes.json': { items: [{ metadata: { name: 'n1' }, status: { conditions: [{ type: 'DiskPressure', status: 'False' }] } }] },
      'studio-pods.json': {
        items: c.studio.map((s, i) => ({
          metadata: { name: `${s.revision}-deployment-${i}`, labels: { 'serving.knative.dev/revision': s.revision } },
          status: { conditions: ready(s.ready) },
        })),
      },
      'studio-revisions.json': {
        items: c.studio.map((s) => ({ metadata: { name: s.revision, creationTimestamp: ago(s.createdMinAgo) } })),
      },
    }
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body))
  }

  const run = (extra: Record<string, string> = {}) =>
    runScript(script, { PATH: `${dir}:${process.env.PATH}`, API_NS: 'sys', WP_NS: 'ws', ...extra })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wpmon-'))
    // Routes exactly the reads the monitor makes; anything else fails loudly.
    writeFileSync(
      join(dir, 'kubectl'),
      `#!/bin/sh
F=${JSON.stringify(dir)}
case "$*" in
  "get ksvc api -n sys -o json") cat "$F/api-ksvc.json" ;;
  "get pods -n ws -o json") cat "$F/wp-pods.json" ;;
  "get ksvc -n ws -l shogo.io/warm-pool=true -o json") cat "$F/wp-ksvcs.json" ;;
  "get nodes -o json") cat "$F/nodes.json" ;;
  "get pods -n sys -l serving.knative.dev/service=studio -o json") cat "$F/studio-pods.json" ;;
  "get revisions -n sys -l serving.knative.dev/service=studio -o json") cat "$F/studio-revisions.json" ;;
  *) echo "unexpected kubectl call: $*" >&2; exit 99 ;;
esac
`,
    )
    chmodSync(join(dir, 'kubectl'), 0o755)
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const steadyPool = [{ name: 'warm-pool-a', createdMinAgo: 40, ready: true }]
  const oneStudio = [{ revision: 'studio-00507', createdMinAgo: 300, ready: true }]

  test('steady state: exit 0, no warnings', async () => {
    writeCluster({ warmPool: steadyPool, studio: oneStudio })
    const r = await run()
    expect(r.out).not.toContain('unexpected kubectl call')
    expect(r.out).not.toContain('WARNING')
    expect(r.code).toBe(0)
  })

  test('two studio revisions Ready right after a deploy only warn', async () => {
    writeCluster({
      warmPool: steadyPool,
      studio: [
        { revision: 'studio-00507', createdMinAgo: 300, ready: true },
        { revision: 'studio-00508', createdMinAgo: 3, ready: true },
      ],
    })
    const r = await run()
    expect(r.out).toContain('WARNING: studio-direct spans 2 revisions (studio-00507, studio-00508)')
    expect(r.out).not.toContain('CRITICAL')
    expect(r.code).toBe(0)
  })

  test('two studio revisions still Ready after the grace window page', async () => {
    writeCluster({
      warmPool: steadyPool,
      studio: [
        { revision: 'studio-00507', createdMinAgo: 300, ready: true },
        { revision: 'studio-00508', createdMinAgo: 30, ready: true },
      ],
    })
    const r = await run()
    expect(r.out).toContain('CRITICAL: studio-direct spans 2 revisions')
    expect(r.code).toBe(1)
  })

  test('a freshly rotated warm pool with nothing Ready yet only warns', async () => {
    writeCluster({
      warmPool: [
        { name: 'warm-pool-b', createdMinAgo: 2, ready: false },
        { name: 'warm-pool-c', createdMinAgo: 2, ready: false },
        { name: 'warm-pool-d', createdMinAgo: 1, ready: false },
      ],
      studio: oneStudio,
    })
    const r = await run()
    expect(r.out).toContain('WARNING: 3 warm-pool ksvcs, 0 Ready yet')
    expect(r.out).not.toContain('CRITICAL')
    expect(r.code).toBe(0)
  })

  test('a warm pool that never becomes Ready pages', async () => {
    writeCluster({
      warmPool: [
        { name: 'warm-pool-a', createdMinAgo: 40, ready: false },
        { name: 'warm-pool-b', createdMinAgo: 2, ready: false },
      ],
      studio: oneStudio,
    })
    const r = await run()
    expect(r.out).toContain('CRITICAL: 2 warm-pool ksvcs but 0 are Ready')
    expect(r.code).toBe(1)
  })

  test('ROLLOUT_GRACE_MIN widens the window', async () => {
    writeCluster({
      warmPool: steadyPool,
      studio: [
        { revision: 'studio-00507', createdMinAgo: 300, ready: true },
        { revision: 'studio-00508', createdMinAgo: 30, ready: true },
      ],
    })
    const r = await run({ ROLLOUT_GRACE_MIN: '45' })
    expect(r.out).toContain('WARNING: studio-direct spans 2 revisions')
    expect(r.code).toBe(0)
  })
})
