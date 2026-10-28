// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  describeSharedFileToken,
  diagnoseSharedFileToken,
  signSharedFileToken,
  verifySharedFileToken,
} from '../shared-file-token'

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

  it('round-trips a workspace-scoped capability with no project', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = signSharedFileToken({
      workspaceId: 'workspace-1',
      path: 'exports/summary.xlsx',
      exp: now + 3600,
      now,
    })

    expect(verifySharedFileToken(token)).toEqual({
      typ: 'shared-file',
      workspaceId: 'workspace-1',
      path: 'exports/summary.xlsx',
      exp: now + 3600,
      iat: now,
    })
    expect(() => signSharedFileToken({
      workspaceId: '',
      path: 'exports/summary.xlsx',
      exp: now + 3600,
    })).toThrow()
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

  describe('diagnoseSharedFileToken', () => {
    const now = Math.floor(Date.now() / 1000)
    const sign = (over: Record<string, unknown> = {}) => {
      const token = signSharedFileToken({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        path: 'reports/q4.pdf',
        exp: now + 3600,
        now,
      })
      return { token, ...over }
    }

    it('accepts a good token and returns its claims', () => {
      const { token } = sign()
      const diagnosis = diagnoseSharedFileToken(token)
      expect(diagnosis.ok).toBe(true)
      if (diagnosis.ok) expect(diagnosis.claims.path).toBe('reports/q4.pdf')
    })

    it('names the failing check instead of just refusing', () => {
      const { token } = sign()
      const [payload, signature] = token.split('.')

      expect(diagnoseSharedFileToken(`${payload}x.${signature}`)).toMatchObject({
        ok: false,
        reason: 'signature_mismatch',
      })
      expect(diagnoseSharedFileToken(payload!)).toMatchObject({ ok: false, reason: 'malformed' })
      expect(diagnoseSharedFileToken('not-a-token')).toMatchObject({ ok: false, reason: 'malformed' })
      expect(
        diagnoseSharedFileToken(
          signSharedFileToken({ workspaceId: 'workspace-1', path: 'a.txt', exp: now - 1, now: now - 7200 }),
        ),
      ).toMatchObject({ ok: false, reason: 'expired' })
    })

    it('logs the claims but never the signature', () => {
      const { token } = sign()
      const [payload, signature] = token.split('.')
      const line = describeSharedFileToken(diagnoseSharedFileToken(`${payload}.${signature}x`))
      expect(line).toContain('reason=signature_mismatch')
      expect(line).toContain('path=reports/q4.pdf')
      expect(line).toContain('projectId=project-1')
      expect(line).not.toContain(signature!)
      expect(line).not.toContain(payload!)
    })
  })
})
