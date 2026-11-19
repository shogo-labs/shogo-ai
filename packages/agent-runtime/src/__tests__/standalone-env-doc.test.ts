// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The env table in `docs/STANDALONE_RUNTIME.md` is the partner contract: it
 * says exactly which variables the runtime reads. It is generated from the
 * source, and this test fails when the two disagree — a variable the code reads
 * but the doc omits, a variable the doc lists that the code no longer reads, or
 * a row whose default/status/purpose drifted (SHO-418).
 */

import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import {
  checkEnvDoc,
  collectRuntimeEnvVars,
  extractDocTable,
  renderEnvTable,
  standaloneStatus,
} from '../../../../scripts/gen-runtime-env-doc'

const REPO_ROOT = resolve(import.meta.dir, '../../../../')

describe('docs/STANDALONE_RUNTIME.md env table', () => {
  test('matches the source exactly', () => {
    const drift = checkEnvDoc(REPO_ROOT)
    expect(drift.noMarkers).toBe(false)
    expect(drift.missing).toEqual([])
    expect(drift.stale).toEqual([])
    expect(drift.changed).toBe(false)
  })

  test('the generator is deterministic', () => {
    expect(renderEnvTable(REPO_ROOT)).toBe(renderEnvTable(REPO_ROOT))
  })

  test('the table lists every variable the runtime reads', () => {
    const vars = collectRuntimeEnvVars(REPO_ROOT)
    const table = extractDocTable(renderEnvTable(REPO_ROOT))!
    for (const name of vars.keys()) {
      expect(table).toContain(`\`${name}\``)
    }
  })

  test('the standalone contract variables are marked required', () => {
    for (const name of ['RUNTIME_AUTH_SECRET', 'AGENT_MODEL', 'OPENAI_BASE_URL']) {
      expect(standaloneStatus(name)).toBe('required')
    }
  })

  test('platform-only variables are marked ignored', () => {
    for (const name of ['SHOGO_API_URL', 'AI_PROXY_URL', 'WARM_POOL_MODE', 'S3_BUCKET']) {
      expect(standaloneStatus(name)).toBe('ignored')
    }
  })

  test('the doc links from SELF_HOSTING.md', () => {
    const selfHosting = require('node:fs').readFileSync(join(REPO_ROOT, 'docs/SELF_HOSTING.md'), 'utf-8')
    expect(selfHosting).toContain('STANDALONE_RUNTIME.md')
  })
})
