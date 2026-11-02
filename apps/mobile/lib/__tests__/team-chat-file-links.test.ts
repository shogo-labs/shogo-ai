// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { parseWorkspaceFileLink, workspaceFileLink } from '../team-chat-links'

const HOSTS = new Set(['studio.shogo.ai'])
const BASE = 'https://studio.shogo.ai'

describe('workspace file links (SHO-284)', () => {
  test('carries the workspace id and the workspace-relative path', () => {
    const link = workspaceFileLink({ workspaceId: 'ws-1', path: 'notes/plan.md' }, BASE)
    expect(link).toBe(`${BASE}/agent?workspace=ws-1&file=notes%2Fplan.md`)
    expect(parseWorkspaceFileLink(link, HOSTS)).toEqual({ workspaceId: 'ws-1', path: 'notes/plan.md' })
  })

  test('a mounted project keeps its <projectId>/… path', () => {
    const link = workspaceFileLink({ workspaceId: 'ws-1', path: 'proj-9/docs/readme.md' }, BASE)
    expect(parseWorkspaceFileLink(link, HOSTS)).toEqual({
      workspaceId: 'ws-1',
      path: 'proj-9/docs/readme.md',
    })
  })

  test('spaces, #, ? and unicode round-trip', () => {
    for (const path of [
      'notes/my plan.md',
      'notes/a#b.md',
      'notes/what?.md',
      'notes/ñandú-計画.md',
      'notes/100% done.md',
      'notes/amp&eq=a.md',
    ]) {
      const link = workspaceFileLink({ workspaceId: 'ws 1/2', path }, BASE)
      expect(parseWorkspaceFileLink(link, HOSTS)).toEqual({ workspaceId: 'ws 1/2', path })
    }
  })

  test('only our own /agent links with both params are ours to open', () => {
    expect(parseWorkspaceFileLink(`${BASE}/agent?file=notes/a.md`, HOSTS)).toBeNull()
    expect(parseWorkspaceFileLink(`${BASE}/agent?workspace=ws-1`, HOSTS)).toBeNull()
    expect(parseWorkspaceFileLink(`${BASE}/agent?chatSessionId=s1`, HOSTS)).toBeNull()
    expect(parseWorkspaceFileLink(`${BASE}/projects/p1?workspace=ws-1&file=a.md`, HOSTS)).toBeNull()
    expect(parseWorkspaceFileLink('https://evil.example/agent?workspace=ws-1&file=a.md', HOSTS)).toBeNull()
    expect(parseWorkspaceFileLink('not a url', HOSTS)).toBeNull()
  })
})
