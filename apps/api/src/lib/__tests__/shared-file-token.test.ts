// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { signSharedFileToken, verifySharedFileToken } from '../shared-file-token'

describe('shared-file-token', () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = 'shared-file-test-secret'
  })

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = originalSecret
  })

  it('round-trips a path-bound capability', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = signSharedFileToken({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: 'reports/final report.pdf',
      exp: now + 3600,
      now,
    })

    expect(verifySharedFileToken(token)).toEqual({
      typ: 'shared-file',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: 'reports/final report.pdf',
      exp: now + 3600,
      iat: now,
    })
  })

  it('rejects tampering, traversal, and expired claims', () => {
    const token = signSharedFileToken({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: 'report.pdf',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const [payload, signature] = token.split('.')
    expect(verifySharedFileToken(`${payload}x.${signature}`)).toBeNull()
    expect(verifySharedFileToken('not-a-token')).toBeNull()
    expect(() => signSharedFileToken({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '../secret.txt',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).toThrow()
    expect(verifySharedFileToken(signSharedFileToken({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: 'report.pdf',
      exp: Math.floor(Date.now() / 1000) - 1,
    }))).toBeNull()
  })

  it('rejects a token after the signing secret changes', () => {
    const token = signSharedFileToken({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: 'report.pdf',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    process.env.BETTER_AUTH_SECRET = 'different-secret'
    expect(verifySharedFileToken(token)).toBeNull()
  })
})
