// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  WORKSPACE_RUNTIME_TOKEN_V1_PREFIX,
  deriveWorkspaceRuntimeToken,
  parseWorkspaceRuntimeToken,
  verifyWorkspaceRuntimeToken,
} from '../workspace-runtime-token'
import { deriveRuntimeToken } from '../runtime-token'

describe('workspace-runtime-token', () => {
  it('derives a self-identifying v1 token', () => {
    const token = deriveWorkspaceRuntimeToken('ws-123')
    expect(token.startsWith(WORKSPACE_RUNTIME_TOKEN_V1_PREFIX)).toBe(true)
    expect(token).toContain('ws-123')
  })

  it('round-trips derive -> parse -> verify', () => {
    const token = deriveWorkspaceRuntimeToken('ws-abc')
    const parsed = parseWorkspaceRuntimeToken(token)
    expect(parsed).toEqual({ format: 'v1', workspaceId: 'ws-abc', hmac: parsed!.hmac })

    const result = verifyWorkspaceRuntimeToken(token)
    expect(result).toEqual({ ok: true, workspaceId: 'ws-abc' })
  })

  it('is deterministic for the same workspace', () => {
    expect(deriveWorkspaceRuntimeToken('ws-x')).toBe(deriveWorkspaceRuntimeToken('ws-x'))
  })

  it('produces distinct tokens per workspace (zero blast radius)', () => {
    expect(deriveWorkspaceRuntimeToken('ws-a')).not.toBe(deriveWorkspaceRuntimeToken('ws-b'))
  })

  it('rejects a token verified against the wrong scope (tampered workspaceId)', () => {
    const token = deriveWorkspaceRuntimeToken('ws-a')
    // Swap the embedded workspace id but keep the original hmac.
    const parsed = parseWorkspaceRuntimeToken(token)!
    const tampered = `${WORKSPACE_RUNTIME_TOKEN_V1_PREFIX}ws-b_${parsed.hmac}`
    expect(verifyWorkspaceRuntimeToken(tampered)).toEqual({ ok: false, reason: 'bad_hmac' })
  })

  it('rejects empty / malformed input', () => {
    expect(verifyWorkspaceRuntimeToken(undefined)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyWorkspaceRuntimeToken('')).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyWorkspaceRuntimeToken('not-a-token')).toEqual({ ok: false, reason: 'malformed' })
    expect(parseWorkspaceRuntimeToken(`${WORKSPACE_RUNTIME_TOKEN_V1_PREFIX}ws_short`)).toBeNull()
  })

  it('does not accept a project runtime token (distinct prefix)', () => {
    const projectToken = deriveRuntimeToken('proj-1')
    expect(parseWorkspaceRuntimeToken(projectToken)).toBeNull()
    expect(verifyWorkspaceRuntimeToken(projectToken)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('throws when workspaceId is empty', () => {
    expect(() => deriveWorkspaceRuntimeToken('')).toThrow(/workspaceId is required/)
  })
})
