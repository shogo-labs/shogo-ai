// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end acceptance for the SHO-127 gate (`deploy.yml` → `promote-images`).
 *
 * The pure `decide()` tests next door never execute `main()`: they cannot see a
 * wrong env name, the run filter that keeps the production (tag push) run out of
 * the "is the staging rollout still running" answer, the exit codes, or the
 * `::error::` prefix GitHub renders. This file runs the real script as a child
 * process with a fake `docker` on PATH and a stubbed GitHub API, so the whole
 * loop is exercised offline — the card's real proof is the next production tag.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { REGISTRATION_GRACE_MS, REPOS, decide } from '../ci/wait-for-staging-images'

const root = resolve(import.meta.dir, '../..')
const SCRIPT = join(root, 'scripts/ci/wait-for-staging-images.ts')
const SHA = '9ed183395fcca9b6f1bbfe542f59d80229279de2'
const STAGING_RUN = {
  id: 39567209766,
  head_branch: 'main',
  event: 'push',
  status: 'in_progress',
  conclusion: null,
  html_url: 'https://github.com/shogo-labs/shogo-ai/actions/runs/39567209766',
}
const PRODUCTION_RUN = {
  id: 39567961829,
  head_branch: 'v2.3.7',
  event: 'push',
  status: 'in_progress',
  conclusion: null,
  html_url: 'https://github.com/shogo-labs/shogo-ai/actions/runs/39567961829',
}

/**
 * Stubs the runs API, and lands the rollout's tag set between polls.
 *
 * `FAKE_TAG_SET_FROM_POLL` = the poll the rollout writes its tags on. The write
 * happens in the wrapped `Bun.sleep`, which `main()` awaits *after* that poll's
 * probes and fetch have both settled — so poll N is the first poll that can see
 * every tag, however the parent was scheduled. Writing it from the fetch stub
 * instead raced the `docker` probes of the same poll (a descheduled parent let
 * them grep a not-yet-written file, and the test flaked the merge queue under
 * load — SHO-236). The `.next` + rename is an atomic swap, so a probe can never
 * read a half-written file.
 */
const PRELOAD = `
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
const everyRepo = (process.env.FAKE_ALL_REPOS ?? '').split(',').filter(Boolean)
const from = Number(process.env.FAKE_TAG_SET_FROM_POLL ?? 0)
let finishedPolls = 0
const sleep = Bun.sleep
Bun.sleep = (ms) => {
  finishedPolls += 1
  if (from > 0 && finishedPolls === from - 1) {
    writeFileSync(process.env.FAKE_PRESENT! + '.next', everyRepo.join('\\n') + '\\n')
    renameSync(process.env.FAKE_PRESENT! + '.next', process.env.FAKE_PRESENT!)
  }
  return sleep(ms)
}
globalThis.fetch = async () => new Response(readFileSync(process.env.FAKE_RUNS!, 'utf8'), { status: 200 })
`

/** `docker buildx imagetools inspect <registry>/shogo/<repo>:<tag>` — 0 iff listed as present. */
const FAKE_DOCKER = `#!/bin/sh
ref="$4"
repo=$(printf '%s' "$ref" | sed -E 's|.*/shogo/([^:]+):.*|\\1|')
grep -qx "$repo" "$FAKE_PRESENT" 2>/dev/null && exit 0
exit 1
`

let dir: string
let env: Record<string, string>

const write = (name: string, body: string) => writeFileSync(join(dir, name), body)

const runGate = async (over: { present?: string[]; runs?: unknown[]; timeoutMs?: number; tagSetFromPoll?: number }) => {
  write('present.txt', `${(over.present ?? ['shogo-api', 'shogo-web']).join('\n')}\n`)
  write('runs.json', JSON.stringify({ workflow_runs: over.runs ?? [STAGING_RUN] }))
  const proc = Bun.spawn([process.execPath, '--preload', join(dir, 'preload.ts'), SCRIPT], {
    env: {
      ...env,
      FAKE_PRESENT: join(dir, 'present.txt'),
      FAKE_RUNS: join(dir, 'runs.json'),
      FAKE_ALL_REPOS: [...REPOS].join(','),
      FAKE_TAG_SET_FROM_POLL: String(over.tagSetFromPoll ?? 0),
      IMAGE_GATE_TIMEOUT_MS: String(over.timeoutMs ?? 5_000),
      IMAGE_GATE_POLL_MS: '25',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code, polls: stdout.split('\n').filter((l) => l.includes('retrying in')).length }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sho127-gate-'))
  write('preload.ts', PRELOAD)
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER)
  chmodSync(join(dir, 'docker'), 0o755)
  env = {
    PATH: `${dir}:${process.env.PATH}`,
    HOME: process.env.HOME ?? dir,
    GH_TOKEN: 'fake',
    REPOSITORY: 'shogo-labs/shogo-ai',
    SHA,
    OCIR_REGISTRY: 'iad.ocir.io/ns',
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

// Each test below spawns a real child process, so it gets the 30s ceiling the
// other spawning acceptance tests in this directory use instead of bun's 5s
// default — a loaded CI runner needs longer than 5s just to start the child, and
// a timeout there ejects a merge-queue entry just as surely as a wrong count
// (SHO-236).
describe('promote-images image gate (real script, fake registry + runs API)', () => {
  it('passes without waiting when every staging tag already exists', async () => {
    const { stdout, code, polls } = await runGate({ present: [...REPOS] })
    expect(code).toBe(0)
    expect(polls).toBe(0)
    expect(stdout).toContain(`staging-${SHA} exists for every promoted repo`)
  }, 30_000)

  it('waits out the v2.3.7 race and then promotes — the incident, replayed', async () => {
    // Poll 1 is 08:16:35: `staging-9ed1…` exists for api+web only, the rollout
    // that writes docs+runtime is still running. Poll 2 is 08:16:42: both exist.
    const { stdout, code, polls } = await runGate({ tagSetFromPoll: 2, timeoutMs: 5_000 })
    expect(code).toBe(0)
    expect(polls).toBe(1)
    expect(stdout).toContain('shogo-docs shogo-runtime')
    expect(stdout).toContain('39567209766')
    expect(stdout).toContain(`staging-${SHA} exists for every promoted repo`)
  }, 30_000)

  it('fails in one poll when the rollout already finished without the tags', async () => {
    const { stdout, code, polls } = await runGate({
      runs: [{ ...STAGING_RUN, status: 'completed', conclusion: 'success' }],
    })
    expect(code).toBe(1)
    expect(polls).toBe(0)
    const error = stdout.split('\n').find((l) => l.startsWith('::error::'))
    expect(error).toBeDefined()
    expect(error).toContain('shogo-docs')
    expect(error).toContain('shogo-runtime')
    expect(error).toContain('39567209766')
    expect(error).toContain('force_rebuild_production=true')
  }, 30_000)

  it('times out — not fails — while the rollout is still running, naming the run', async () => {
    const { stdout, code } = await runGate({ timeoutMs: 150 })
    expect(code).toBe(1)
    const error = stdout.split('\n').find((l) => l.startsWith('::error::Timed out'))
    expect(error).toBeDefined()
    expect(error).toContain('shogo-docs shogo-runtime')
    expect(error).toContain('39567209766')
    expect(error).toContain('force_rebuild_production=true')
  }, 30_000)

  it('never mistakes this release’s own production run for the staging rollout', async () => {
    // The production run is in_progress by definition — it is the job running the
    // gate — so an unfiltered `head_sha` query would wait out the whole 60 min.
    const { stdout, code } = await runGate({ runs: [PRODUCTION_RUN], timeoutMs: 150 })
    expect(code).toBe(1)
    expect(stdout).toContain('no staging rollout for this commit has registered yet')
    expect(stdout).not.toContain('39567961829')
    expect(stdout).toContain('none found for this commit')
  }, 30_000)
})

describe('the gate and the re-tag loop promote the same repos', () => {
  it('gates on exactly the REPOS the workflow re-tags', () => {
    const workflow = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8')
    const loop = /REPOS="([^"]+)"/.exec(workflow)
    expect(loop).not.toBeNull()
    expect(loop![1].split(/\s+/)).toEqual([...REPOS])
  })
})

describe('every failure names a remedy that applies to its own branch', () => {
  const missing = ['shogo-docs', 'shogo-runtime']
  const finished = decide({
    missing,
    stagingRuns: [{ ...STAGING_RUN, status: 'completed', conclusion: 'success' }],
    sha: SHA,
    elapsedMs: 60_000,
  })
  const neverStarted = decide({ missing, stagingRuns: [], sha: SHA, elapsedMs: REGISTRATION_GRACE_MS })

  it('sends a finished rollout to its tag step, not back to waiting for it', () => {
    expect(finished.kind).toBe('fail')
    if (finished.kind !== 'fail') return
    expect(finished.message).not.toContain("Wait for this commit's staging rollout to finish")
    expect(finished.message).toContain('Complete staging release tag set')
    expect(finished.message).toContain('force_rebuild_production=true')
  })

  it('tells a rollout that never started to re-run, not to wait for it', () => {
    expect(neverStarted.kind).toBe('fail')
    if (neverStarted.kind !== 'fail') return
    expect(neverStarted.message).not.toContain("Wait for this commit's staging rollout to finish")
    expect(neverStarted.message).toContain("Re-run this commit's main-branch staging deploy")
    expect(neverStarted.message).toContain('force_rebuild_production=true')
  })
})

describe('the runbook describes the wait, not the race', () => {
  it('names the gate and the rollout that writes the tag set', () => {
    const doc = readFileSync(join(root, 'docs/runbooks/deploy-prod.md'), 'utf8')
    expect(doc).toContain('scripts/ci/wait-for-staging-images.ts')
    expect(doc).toContain('waits for that tag set')
  })
})
