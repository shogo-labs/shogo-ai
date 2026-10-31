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

describe('workspace tokens and the dev-only signing fallback', () => {
  it('refuses to mint in-cluster with only the localhost-only default', () => {
    const saved = {
      aiProxy: process.env.AI_PROXY_SECRET,
      better: process.env.BETTER_AUTH_SECRET,
      preview: process.env.PREVIEW_TOKEN_SECRET,
      nodeEnv: process.env.NODE_ENV,
      k8s: process.env.KUBERNETES_SERVICE_HOST,
    }
    delete process.env.AI_PROXY_SECRET
    delete process.env.BETTER_AUTH_SECRET
    delete process.env.PREVIEW_TOKEN_SECRET
    process.env.NODE_ENV = 'staging'
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    try {
      // A workspace runtime's RUNTIME_AUTH_SECRET is a `wrt_v1_` token, so the
      // same fallback would mint one the API refuses as bad_hmac (SHO-265).
      expect(() => deriveWorkspaceRuntimeToken('ws-heal')).toThrow(/localhost-only signing secret/)
    } finally {
      const put = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      put('AI_PROXY_SECRET', saved.aiProxy)
      put('BETTER_AUTH_SECRET', saved.better)
      put('PREVIEW_TOKEN_SECRET', saved.preview)
      put('NODE_ENV', saved.nodeEnv)
      put('KUBERNETES_SERVICE_HOST', saved.k8s)
    }
  })
})
