// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The contract module must load when `fs` is stubbed.
 *
 * `build-workspace-env` (pure, no file IO) reads the runtime-key rule from this
 * module, and the knative manager suites stub `fs` with the two calls they need
 * so a kubeconfig is never read from the runner. When this module imported
 * named `fs` exports, those suites died at link time with
 * `SyntaxError: Export named 'chmodSync' not found in module 'node:fs'` — the
 * guard breaks, and the reason had nothing to do with the builder under test.
 *
 * So: stub `fs` down to two keys, then import. Only the naming rules may be
 * needed, and the file-apply half must not be bound until it is called.
 */

import { describe, expect, mock, test } from 'bun:test'

mock.module('fs', () => ({ existsSync: () => false, readFileSync: () => '' }))

const mod = await import('../workspace-root-secrets')

describe('importable with a stubbed fs', () => {
  test('the naming rules load and answer', () => {
    expect(mod.isWorkspaceSecretFile('.env')).toBe(true)
    expect(mod.isWorkspaceSecretFile('.env.production')).toBe(true)
    expect(mod.isWorkspaceSecretFile('.env.example')).toBe(false)
    expect(mod.workspaceRuntimeKey({ workspaceId: 'ws-1' })).toBe('ws:ws-1')
    expect(mod.workspaceRuntimeKey({ workspaceId: 'ws-1', anchorProjectId: 'p1' })).toBe(
      'ws:proj:p1',
    )
  })

  test('the gitignore set the builder reads is available too', () => {
    expect(mod.WORKSPACE_SECRET_GITIGNORE_LINES).toContain('.env.*')
  })
})
