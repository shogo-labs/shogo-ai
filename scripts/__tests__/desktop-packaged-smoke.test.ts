// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { apiPortFromLog } from '../ci/desktop-packaged-smoke'

describe('apiPortFromLog', () => {
  it('reads the API port the packaged app announced (the last one wins after a restart)', () => {
    const log = [
      '[Desktop] Port 39100 is in use, using port 39101 instead',
      '[Desktop] Ports: API=39101, RuntimeBase=39110',
      '[Desktop] API server is healthy',
      '[Desktop] Ports: API=39102, RuntimeBase=39110',
    ].join('\n')
    expect(apiPortFromLog(log)).toBe(39102)
    expect(apiPortFromLog('[Desktop] API server is healthy')).toBeNull()
  })

  it('matches the line the desktop main process actually logs', () => {
    const src = readFileSync(join(import.meta.dir, '../../apps/desktop/src/local-server.ts'), 'utf-8')
    expect(src).toContain('console.log(`[Desktop] Ports: API=${apiPort}, RuntimeBase=${RUNTIME_BASE_PORT}`)')
  })
})
