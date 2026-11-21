// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-474: selectPooledWorkspaceParent and selectAtCapWorkspaceParent
 * Tests the allowance-based selection replacing the old business/enterprise check.
 */

import { describe, expect, it } from 'bun:test'
import {
  selectPooledWorkspaceParent,
  selectAtCapWorkspaceParent,
  type PooledWorkspaceCandidate,
  type WorkspacePlanMap,
} from '../pooledWorkspaceParent'

const ws = (id: string, parentId?: string | null): PooledWorkspaceCandidate => ({
  id,
  name: id,
  parentWorkspaceId: parentId ?? null,
})

describe('selectPooledWorkspaceParent — allowance-based', () => {
  it('returns null when no manageable workspaces', () => {
    const result = selectPooledWorkspaceParent([ws('a')], 'a', {
      a: { planId: 'basic', canManageChildren: false, includedWorkspaces: { limit: 3, used: 1 } },
    })
    expect(result).toBeNull()
  })

  it('returns null when at cap', () => {
    const result = selectPooledWorkspaceParent([ws('a')], 'a', {
      a: { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 3 } },
    })
    expect(result).toBeNull()
  })

  it('returns a Basic parent with room (used=2, limit=3)', () => {
    const result = selectPooledWorkspaceParent([ws('a')], 'a', {
      a: { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 2 } },
    })
    expect(result?.id).toBe('a')
  })

  it('returns a Business (unlimited) parent', () => {
    const result = selectPooledWorkspaceParent([ws('a')], 'a', {
      a: { planId: 'business', canManageChildren: true, includedWorkspaces: { limit: null, used: 50 } },
    })
    expect(result?.id).toBe('a')
  })

  it('prefers the current workspace', () => {
    const workspaces = [ws('a'), ws('b')]
    const plans: WorkspacePlanMap = {
      a: { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 1 } },
      b: { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 1 } },
    }
    expect(selectPooledWorkspaceParent(workspaces, 'b', plans)?.id).toBe('b')
  })

  it('when current is not eligible, picks the one with most room', () => {
    const workspaces = [ws('a'), ws('b'), ws('c')]
    const plans: WorkspacePlanMap = {
      a: { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 2 } }, // 1 room
      b: { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 3 } }, // 0 room (at cap)
      c: { planId: 'pro', canManageChildren: true, includedWorkspaces: { limit: 10, used: 2 } },  // 8 room
    }
    expect(selectPooledWorkspaceParent(workspaces, 'b', plans)?.id).toBe('c')
  })

  it('falls back to business/enterprise check for old server (no includedWorkspaces)', () => {
    const workspaces = [ws('a')]
    const plans: WorkspacePlanMap = {
      a: { planId: 'business', canManageChildren: true },
    }
    expect(selectPooledWorkspaceParent(workspaces, 'a', plans)?.id).toBe('a')
  })

  it('skips child workspaces', () => {
    const workspaces = [ws('child', 'parent')]
    const plans: WorkspacePlanMap = {
      child: { planId: 'business', canManageChildren: true, includedWorkspaces: { limit: null, used: 1 } },
    }
    expect(selectPooledWorkspaceParent(workspaces, 'child', plans)).toBeNull()
  })
})

describe('selectAtCapWorkspaceParent', () => {
  it('returns null when there are no managed workspaces', () => {
    expect(selectAtCapWorkspaceParent([ws('a')], 'a', {})).toBeNull()
  })

  it('returns null when the managed workspace has room', () => {
    const result = selectAtCapWorkspaceParent([ws('a')], 'a', {
      a: { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 2 } },
    })
    expect(result).toBeNull()
  })

  it('returns a workspace that is exactly at its cap', () => {
    const result = selectAtCapWorkspaceParent([ws('a')], 'a', {
      a: { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 3 } },
    })
    expect(result?.id).toBe('a')
  })

  it('returns null for unlimited workspaces (they are never at cap)', () => {
    const result = selectAtCapWorkspaceParent([ws('a')], 'a', {
      a: { planId: 'business', canManageChildren: true, includedWorkspaces: { limit: null, used: 50 } },
    })
    expect(result).toBeNull()
  })

  it('returns null for free-plan workspaces (they show plan_required, not upgrade)', () => {
    const result = selectAtCapWorkspaceParent([ws('a')], 'a', {
      a: { planId: 'free', canManageChildren: true, includedWorkspaces: { limit: 1, used: 1 } },
    })
    expect(result).toBeNull()
  })
})
