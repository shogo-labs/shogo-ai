// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '..', 'ci', 'failing-tests.sh')

/** A `bun run test` capture as the isolated runner prints it (no gh prefix). */
const PLAIN_LOG = [
  '  src/__tests__/qa-sho444-active-capacity.acceptance.test.ts ... OK (8 pass, 0 fail, 0 skip, 258ms)',
  '  src/__tests__/qa-sho424-vm-compute-billing.acceptance.test.ts ... bun test v1.4.4 (38afee6c8)',
  '[vm-usage-bill] shadow: 1 row(s) would bill $0.0940',
  'FAIL (12 pass, 1 fail, 0 skip, 3108ms)',
  '(fail) GET /api/admin/compute > is super-admin only, and answers the fleet numbers [71.79ms]',
  '  src/__tests__/qa-sho479-gemini-thinking-billing.acceptance.test.ts ... OK (8 pass, 0 fail, 0 skip, 551ms)',
  '  src/__tests__/qa-sho481-auto-cloud-tiers.acceptance.test.ts ... OK (2 pass, 0 fail, 0 skip, 87ms)',
  '  FAIL  apps/api    687.9s',
].join('\n')

/** The same log through `gh run view --log-failed`, which prefixes every line. */
const GH_PREFIXED_LOG = PLAIN_LOG.split('\n')
  .map((line) => `Test (api + mobile)\tTest unsharded packages\t2026-11-22T02:58:07.5524825Z ${line}`)
  .join('\n')

/** The same log through `gh api .../actions/jobs/<id>/logs` — bare timestamp only. */
const GH_JOB_LOG = PLAIN_LOG.split('\n')
  .map((line) => `2026-11-22T02:58:07.5524825Z ${line}`)
  .join('\n')

/** A log where one file failed in the parallel pass and again in the retry. */
const RETRY_LOG = [
  '  src/__tests__/qa-sho444-active-capacity.acceptance.test.ts ... OK (8 pass, 0 fail, 0 skip, 258ms)',
  '  src/__tests__/qa-sho424-vm-compute-billing.acceptance.test.ts ... bun test v1.4.4 (38afee6c8)',
  'FAIL (12 pass, 1 fail, 0 skip, 3108ms)',
  '(fail) GET /api/admin/compute > is super-admin only, and answers the fleet numbers [71.79ms]',
  'retrying 1 failed file(s) serially...',
  'Total: 17597 pass, 1 fail, 214 skip across 1201 files',
  '✗ 1 package(s) had test failures',
  'Failed files (1):',
  '  src/__tests__/qa-sho424-vm-compute-billing.acceptance.test.ts  (exit 1)',
  '##[group]src/__tests__/qa-sho424-vm-compute-billing.acceptance.test.ts:',
  '(fail) GET /api/admin/compute > is super-admin only, and answers the fleet numbers [58.16ms]',
  '##[endgroup]',
].join('\n')

function run(log: string, max?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'failing-tests-'))
  try {
    const file = join(dir, 'run.log')
    writeFileSync(file, log)
    const result = Bun.spawnSync(
      ['bash', SCRIPT, file, ...(max === undefined ? [] : [String(max)])],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    return result.stdout.toString()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('failing-tests.sh', () => {
  test('names the failing file, not the passing ones around it', () => {
    const out = run(PLAIN_LOG)
    expect(out).toContain('FAIL src/__tests__/qa-sho424-vm-compute-billing.acceptance.test.ts')
    expect(out).not.toContain('qa-sho444')
    expect(out).not.toContain('qa-sho479')
    expect(out).not.toContain('qa-sho481')
  })

  test('keeps the named failing test under its file', () => {
    const out = run(PLAIN_LOG)
    expect(out).toContain('(fail) GET /api/admin/compute > is super-admin only')
  })

  test('reads a gh-prefixed log the same way', () => {
    expect(run(GH_PREFIXED_LOG)).toBe(run(PLAIN_LOG))
  })

  test('reads a per-job log the same way', () => {
    // main-health.yml's report step is part of the run it reports on, so a
    // whole-run `gh run view --log-failed` is refused mid-run; it reads the
    // per-job logs instead, whose lines carry only a bare timestamp.
    expect(run(GH_JOB_LOG)).toBe(run(PLAIN_LOG))
  })

  test('does not mistake the package summary for a file', () => {
    expect(run(PLAIN_LOG)).not.toContain('FAIL apps/api')
  })

  test('prints a failing test once when the retry repeats it', () => {
    // A file that fails in the parallel pass and again in the serial retry is
    // printed twice in the log, at different durations. One line is enough.
    const out = run(RETRY_LOG)
    expect(out.split('(fail) GET /api/admin/compute').length - 1).toBe(1)
    expect(out).toContain('FAIL src/__tests__/qa-sho424-vm-compute-billing.acceptance.test.ts')
  })

  test('does not report the run summary as a failing test', () => {
    expect(run(RETRY_LOG)).not.toContain('package(s) had test failures')
  })

  test('strips the colour codes a runner log always carries', () => {
    // `gh api .../logs` hands back SGR codes inline ("\u001b[36;1m..."). Left in,
    // they land in the issue body and a name is no longer a name.
    const ansi = PLAIN_LOG.split('\n')
      .map((line) => `\u001b[36;1m${line}\u001b[0m`)
      .join('\n')
    const out = run(ansi)
    expect(out).toBe(run(PLAIN_LOG))
    expect(out).not.toContain('\u001b')
  })

  test('honours the line cap', () => {
    const out = run(PLAIN_LOG, 1)
    expect(out.trim().split('\n')).toHaveLength(1)
  })

  test('says so when there is no log', () => {
    const result = Bun.spawnSync(['bash', SCRIPT, join(tmpdir(), 'nope-does-not-exist.log')], {
      stdout: 'pipe',
    })
    expect(result.stdout.toString()).toContain('(no log at')
  })
})
