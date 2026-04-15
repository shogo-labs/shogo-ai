// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the Remote HTTP Interceptor
 */

import { describe, it, expect } from 'vitest'
import {
  shouldRouteToRemote,
  rewritePathForRemote,
  REMOTE_ROUTED_PREFIXES,
  REMOTE_EXCLUDED_PATTERNS,
  ROUTE_TABLE,
} from '../remote-http-interceptor'

describe('shouldRouteToRemote', () => {
  // ─── Paths that SHOULD be routed to remote ─────────────────────────
  it('routes /api/projects to remote', () => {
    expect(shouldRouteToRemote('/api/projects')).toBe(true)
  })

  it('routes /api/projects/<id> to remote', () => {
    expect(shouldRouteToRemote('/api/projects/proj_123')).toBe(true)
  })

  it('routes /api/projects with query params to remote', () => {
    expect(shouldRouteToRemote('/api/projects?workspaceId=ws_1')).toBe(true)
  })

  it('routes /api/chat-sessions to remote', () => {
    expect(shouldRouteToRemote('/api/chat-sessions')).toBe(true)
  })

  it('routes /api/chat-messages to remote', () => {
    expect(shouldRouteToRemote('/api/chat-messages')).toBe(true)
  })

  it('routes /api/folders to remote', () => {
    expect(shouldRouteToRemote('/api/folders')).toBe(true)
  })

  it('routes /api/starred-projects to remote', () => {
    expect(shouldRouteToRemote('/api/starred-projects')).toBe(true)
  })

  it('routes /api/tool-call-logs to remote', () => {
    expect(shouldRouteToRemote('/api/tool-call-logs')).toBe(true)
  })

  // ─── Paths that should NOT be routed to remote ─────────────────────
  it('does NOT route /api/auth to remote', () => {
    expect(shouldRouteToRemote('/api/auth')).toBe(false)
  })

  it('does NOT route /api/billing to remote', () => {
    expect(shouldRouteToRemote('/api/billing')).toBe(false)
  })

  it('does NOT route /api/instances to remote', () => {
    expect(shouldRouteToRemote('/api/instances')).toBe(false)
  })

  it('does NOT route /api/workspaces to remote', () => {
    expect(shouldRouteToRemote('/api/workspaces')).toBe(false)
  })

  it('does NOT route /api/members to remote', () => {
    expect(shouldRouteToRemote('/api/members')).toBe(false)
  })

  it('does NOT route /health to remote', () => {
    expect(shouldRouteToRemote('/health')).toBe(false)
  })

  // ─── Excluded paths (match prefix but explicitly excluded) ─────────
  it('does NOT route /api/projects/:id/publish to remote', () => {
    expect(shouldRouteToRemote('/api/projects/proj_123/publish')).toBe(false)
  })

  it('does NOT route /api/projects/:id/thumbnail to remote', () => {
    expect(shouldRouteToRemote('/api/projects/proj_123/thumbnail')).toBe(false)
  })

  it('does NOT route /api/projects/:id/thumbnail/capture to remote', () => {
    expect(shouldRouteToRemote('/api/projects/proj_123/thumbnail/capture')).toBe(false)
  })
})

describe('rewritePathForRemote', () => {
  const baseUrl = 'https://studio.shogo.ai/api/instances/inst_abc/p'

  it('rewrites /api/projects to the proxy URL', () => {
    expect(rewritePathForRemote('/api/projects', baseUrl)).toBe(
      'https://studio.shogo.ai/api/instances/inst_abc/p/api/projects',
    )
  })

  it('rewrites /api/projects/<id> to the proxy URL', () => {
    expect(rewritePathForRemote('/api/projects/proj_123', baseUrl)).toBe(
      'https://studio.shogo.ai/api/instances/inst_abc/p/api/projects/proj_123',
    )
  })

  it('rewrites /api/chat-sessions to the proxy URL', () => {
    expect(rewritePathForRemote('/api/chat-sessions', baseUrl)).toBe(
      'https://studio.shogo.ai/api/instances/inst_abc/p/api/chat-sessions',
    )
  })

  it('preserves query params in the path', () => {
    expect(
      rewritePathForRemote('/api/projects?workspaceId=ws_1', baseUrl),
    ).toBe(
      'https://studio.shogo.ai/api/instances/inst_abc/p/api/projects?workspaceId=ws_1',
    )
  })
})

describe('configuration', () => {
  it('has all expected prefixes', () => {
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/projects')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/chat-sessions')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/chat-messages')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/folders')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/starred-projects')
    expect(REMOTE_ROUTED_PREFIXES).toContain('/api/tool-call-logs')
  })

  it('has exclusion patterns', () => {
    expect(REMOTE_EXCLUDED_PATTERNS.length).toBeGreaterThan(0)
  })
})
