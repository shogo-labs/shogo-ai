// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runs the real conflict-watchdog CronJob script, extracted from its manifest,
 * with a `kubectl` stub that answers `exec ... psql` from fixtures (SHO-585 §D).
 *
 * What is asserted is the behaviour the 2026-11-24 outage needed and did not
 * get: the failing transaction is found from the database (origin LSN + a
 * publisher slot peek, never a 15-minute log window), a known-safe conflict is
 * skipped at that LSN, an unknown cause is re-enabled only a bounded number of
 * times, and a subscription that stops applying pages even while it is
 * *enabled* — which is exactly how the mesh sat broken for 10 hours.
 *
 *   bun test scripts/__tests__/conflict-watchdog.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

const REPO = resolve(import.meta.dir, '../..')
const MANIFEST = 'k8s/cnpg/logical-replication/conflict-watchdog.yaml'

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

const SCRIPT = cronJobScript(MANIFEST)
const BASH = existsSync('/bin/bash') ? '/bin/bash' : Bun.which('bash')
if (!BASH) throw new Error('the watchdog CronJob runs bash; this test needs it')

/**
 * What the fake primary answers. Each entry is matched against a marker comment
 * the script writes into its SQL (`-- wd:<name>`), so the stub does not care
 * about whitespace or the surrounding query.
 */
interface State {
  subs: string[]
  origins: Record<string, string>
  conninfo: Record<string, string>
  peerLsn: string | null
  ahead: boolean
  syncStuck: number
  conflictDelta: number
  peek: string[]
  log: string[]
  stallMinutes: number
  streak: number
}

const BASE: State = {
  subs: [],
  origins: {},
  conninfo: {},
  peerLsn: '0/2000000',
  ahead: true,
  syncStuck: 0,
  conflictDelta: 0,
  peek: [],
  log: [],
  stallMinutes: 0,
  streak: 0,
}

/** Records every mutation the script asks for, so we can assert on it. */
interface Recorder {
  skips: string[]
  enables: string[]
  statements: string[]
}

let workdir = ''
let statePath = ''
let recorderPath = ''
let stubPath = ''

function writeState(patch: Partial<State>) {
  writeFileSync(statePath, JSON.stringify({ ...BASE, ...patch }))
  writeFileSync(recorderPath, JSON.stringify({ skips: [], enables: [], statements: [] } satisfies Recorder))
}

function readRecorder(): Recorder {
  return JSON.parse(readFileSync(recorderPath, 'utf8'))
}

const STUB = `#!/bin/bash
# Fake kubectl: answers from the fixture, records mutations.
STATE="\${WD_STATE}"
REC="\${WD_RECORDER}"
q() { jq -r "$1" "$STATE"; }
record() {
  jq --arg s "$1" '. + {statements: (.statements + [$s])}' "$REC" > "$REC.tmp" && mv "$REC.tmp" "$REC"
}
record_skip() {
  jq --arg s "$1" '.skips = (.skips + [$s]) | .statements = (.statements + [$s])' "$REC" > "$REC.tmp" && mv "$REC.tmp" "$REC"
}
record_enable() {
  jq --arg s "$1" '.enables = (.enables + [$s]) | .statements = (.statements + [$s])' "$REC" > "$REC.tmp" && mv "$REC.tmp" "$REC"
}

if [ "$1" = "get" ]; then
  echo "platform-pg-1"
  exit 0
fi
if [ "$1" = "logs" ]; then
  q '.log[]' | sed 's/^/{"record":{"message":"&","context":""}}/'
  exit 0
fi
if [ "$1" != "exec" ]; then
  echo "unexpected kubectl $*" >&2
  exit 1
fi

# Everything after the pod/container flags is psql plus its args.
shift 7 2>/dev/null || true
SQL="\${!#}"
case "$SQL" in
  *"wd:subs"*)
    q '.subs[]'
    ;;
  *"wd:origin"*)
    curl_origin=$(echo "$SQL" | sed -n "s/.*external_id = '\\([^']*\\)'.*/\\1/p")
    jq -r --arg o "$curl_origin" '.origins[$o] // ""' "$STATE"
    ;;
  *"wd:conninfo"*)
    sub=$(echo "$SQL" | sed -n "s/.*subname = '\\([^']*\\)'.*/\\1/p")
    jq -r --arg s "$sub" '.conninfo[$s] // ""' "$STATE"
    ;;
  *"wd:peer-lsn"*)
    jq -r '.peerLsn // ""' "$STATE"
    ;;
  *"wd:ahead"*)
    jq -r '.ahead' "$STATE"
    ;;
  *"wd:sync"*)
    jq -r '.syncStuck' "$STATE"
    ;;
  *"wd:conflict-save"*)
    exit 0
    ;;
  *"wd:conflict"*)
    jq -r '.conflictDelta' "$STATE"
    ;;
  *"wd:peek"*)
    jq -r '.peek[]' "$STATE"
    ;;
  *"wd:skip-save"*)
    record "skip-save"
    exit 0
    ;;
  *"wd:streak"*)
    jq -r '.streak' "$STATE"
    ;;
  *"wd:stall"*)
    jq -r '.stallMinutes' "$STATE"
    ;;
  *"wd:state"*|*"wd:save"*)
    exit 0
    ;;
  *"SKIP (lsn="*)
    record_skip "$SQL"
    exit 0
    ;;
  *"ENABLE"*)
    record_enable "$SQL"
    exit 0
    ;;
  *)
    echo "unknown SQL: $SQL" >&2
    exit 1
    ;;
esac
`

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), `wd-${process.pid}-${Date.now()}`))
  statePath = join(workdir, 'state.json')
  recorderPath = join(workdir, 'recorder.json')
  const bin = join(workdir, 'bin')
  mkdirSync(bin)
  stubPath = join(bin, 'kubectl')
  writeFileSync(stubPath, STUB)
  chmodSync(stubPath, 0o755)
  writeState({})
})

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true })
})

async function run(patch: Partial<State>, env: Record<string, string> = {}) {
  writeState(patch)
  const proc = Bun.spawn([BASH, '-ec', SCRIPT], {
    env: {
      ...process.env,
      PATH: `${join(workdir, 'bin')}:${process.env.PATH ?? ''}`,
      WD_STATE: statePath,
      WD_RECORDER: recorderPath,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err, rec: readRecorder() }
}

const EU = 'sub_from_eu'
const SUB_ROW = (sub: string, enabled: boolean) => `${sub}|12345|${enabled ? 'true' : 'false'}|sub_from_eu_slot|shogo_all_pub`

describe('a known-safe conflict is skipped at the peeked LSN', () => {
  test('skips the first transaction past the origin LSN and re-enables', async () => {
    const result = await run({
      subs: [SUB_ROW(EU, false)],
      origins: { 'pg_12345': '0/1000000' },
      conninfo: { [EU]: 'host=eu-db user=repl password=x' },
      conflictDelta: 1,
      // B (before the origin → ignored), B (the failing one), R, I
      peek: [
        'B|0/A000000|||false',
        'B|0/1A00000|||true',
        'R||public.social_comment||',
        'I|||zernio_cmt_1 MERGE 2026-11-24|',
        'B|0/2A00000|||true',
      ],
    })

    expect(result.code).toBe(0)
    expect(result.out).toContain(`WATCHDOG_SKIP sub=${EU} relation=public.social_comment lsn=0/1A00000`)
    expect(result.out).toContain('keys=')
    expect(result.rec.skips).toEqual([`ALTER SUBSCRIPTION ${EU} SKIP (lsn='0/1A00000'); ALTER SUBSCRIPTION ${EU} ENABLE;`])
  })

  test('finds the conflict with no log line in the window (the outage case)', async () => {
    const result = await run({
      subs: [SUB_ROW(EU, false)],
      origins: { 'pg_12345': '0/1000000' },
      conninfo: { [EU]: 'host=eu-db user=repl' },
      conflictDelta: 2,
      peek: ['B|0/1B00000|||true', 'R||public.conversation_message||', 'I|||hello|'],
      log: [], // the error aged out of `kubectl logs --since=15m`
    })

    expect(result.rec.skips).toHaveLength(1)
    expect(result.out).toContain('lsn=0/1B00000')
  })

  test('an unknown cause is re-enabled at most MAX_BLIND_ENABLE times', async () => {
    const withinBudget = await run({
      subs: [SUB_ROW(EU, false)],
      origins: { 'pg_12345': '0/1000000' },
      conninfo: { [EU]: 'host=eu-db user=repl' },
      conflictDelta: 0,
      peek: [],
      streak: 2,
    })
    expect(withinBudget.rec.enables).toHaveLength(1)
    expect(withinBudget.out).toContain('no classified cause')

    const exhausted = await run({
      subs: [SUB_ROW(EU, false)],
      origins: { 'pg_12345': '0/1000000' },
      conninfo: { [EU]: 'host=eu-db user=repl' },
      conflictDelta: 0,
      peek: [],
      streak: 4, // one more than MAX_BLIND_ENABLE
    })
    expect(exhausted.code).toBe(1)
    expect(exhausted.rec.enables).toHaveLength(0)
    expect(exhausted.out).toContain(`WATCHDOG_ENABLE_BUDGET_EXHAUSTED sub=${EU}`)
  })

  test('a stalled ENABLED subscription pages', async () => {
    const result = await run({
      subs: [SUB_ROW(EU, true)],
      origins: { 'pg_12345': '0/1000000' },
      conninfo: { [EU]: 'host=eu-db user=repl' },
      ahead: true,
      stallMinutes: 42,
    })
    expect(result.code).toBe(1)
    expect(result.out).toContain(`REPLICATION_STALLED sub=${EU} minutes=42`)
    expect(result.out).toContain('enabled=true')
    expect(result.rec.enables).toHaveLength(0)
    expect(result.rec.skips).toHaveLength(0)
  })

  test('a subscription that is caught up is not stalled', async () => {
    const result = await run({
      subs: [SUB_ROW(EU, true)],
      origins: { 'pg_12345': '0/2000000' },
      conninfo: { [EU]: 'host=eu-db user=repl' },
      ahead: false,
      stallMinutes: 600, // the clock was reset because nothing is pending
    })
    expect(result.code).toBe(0)
    expect(result.out).not.toContain('REPLICATION_STALLED')
  })

  test('a tablesync error is not re-enabled (unchanged branch)', async () => {
    const result = await run({
      subs: [SUB_ROW(EU, false)],
      origins: { 'pg_12345': '0/1000000' },
      conninfo: { [EU]: 'host=eu-db user=repl' },
      syncStuck: 2,
      log: ['{ "record": { "message": "could not start initial sync", "context": "COPY public.work_items, line 42: duplicate key value" } }'],
    })
    expect(result.code).toBe(1)
    expect(result.out).toContain('WATCHDOG_TABLESYNC_ERROR')
    expect(result.rec.enables).toHaveLength(0)
    expect(result.rec.skips).toHaveLength(0)
  })

  test('schema skew is re-enabled without a skip and without paging', async () => {
    const result = await run({
      subs: [SUB_ROW(EU, false)],
      origins: { 'pg_12345': '0/1000000' },
      conninfo: { [EU]: 'host=eu-db user=repl' },
      log: ['{ "record": { "message": "logical replication target relation \\"public.work_items\\" is missing replicated column: \\"newCol\\"", "context": "" } }'],
    })
    expect(result.rec.enables).toHaveLength(1)
    expect(result.rec.skips).toHaveLength(0)
    expect(result.out).toContain('WATCHDOG_SCHEMA_SKEW')
  })

  test('nothing to do is green', async () => {
    const result = await run({ subs: [SUB_ROW(EU, true)], origins: { 'pg_12345': '0/2000000' }, conninfo: { [EU]: 'host=eu-db' }, ahead: false })
    expect(result.code).toBe(0)
    expect(result.out).toContain('Watchdog complete (skips=0 stalls=0 exit=0)')
  })

  test('an unreachable publisher skips the stall check instead of failing', async () => {
    const result = await run({
      subs: [SUB_ROW(EU, true)],
      origins: { 'pg_12345': '0/1000000' },
      conninfo: { [EU]: 'host=eu-db' },
      peerLsn: null,
    })
    expect(result.code).toBe(0)
    expect(result.out).toContain('WATCHDOG_PEER_UNREACHABLE')
  })
})
