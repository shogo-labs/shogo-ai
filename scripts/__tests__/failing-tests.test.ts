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

  test('does not mistake the package summary for a file', () => {
    expect(run(PLAIN_LOG)).not.toContain('FAIL apps/api')
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
