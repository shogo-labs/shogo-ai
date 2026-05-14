// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  getProjectOwnerUserId,
  getProjectUser,
  setProjectUser,
} from '../project-user-context'

const HOUR_MS = 60 * 60 * 1000

describe('project-user-context (in-memory)', () => {
  afterEach(() => {
    // Best-effort isolation: clear known projectIds between tests.
    setProjectUser('proj-1', 'noop')
    setProjectUser('proj-2', 'noop')
  })

  it('returns undefined for an unknown project', () => {
    expect(getProjectUser('never-set')).toBeUndefined()
  })

  it('roundtrips userId via set then get', () => {
    setProjectUser('proj-1', 'user-1')
    expect(getProjectUser('proj-1')).toBe('user-1')
  })

  it('overwrites previous userId for the same project', () => {
    setProjectUser('proj-1', 'user-a')
    setProjectUser('proj-1', 'user-b')
    expect(getProjectUser('proj-1')).toBe('user-b')
  })

  it('keeps projects isolated from each other', () => {
    setProjectUser('proj-1', 'user-a')
    setProjectUser('proj-2', 'user-b')
    expect(getProjectUser('proj-1')).toBe('user-a')
    expect(getProjectUser('proj-2')).toBe('user-b')
  })

  describe('expiry', () => {
    let nowSpy: ReturnType<typeof spyOn> | null = null
    afterEach(() => {
      nowSpy?.mockRestore()
      nowSpy = null
    })

    it('returns userId before 1h expiry threshold', () => {
      const base = 1_000_000_000_000
      nowSpy = spyOn(Date, 'now').mockReturnValue(base)
      setProjectUser('proj-1', 'user-1')
      nowSpy.mockReturnValue(base + HOUR_MS - 1)
      expect(getProjectUser('proj-1')).toBe('user-1')
    })

    it('returns undefined and evicts after 1h expiry', () => {
      const base = 1_000_000_000_000
      nowSpy = spyOn(Date, 'now').mockReturnValue(base)
      setProjectUser('proj-1', 'user-1')
      nowSpy.mockReturnValue(base + HOUR_MS + 1)
      expect(getProjectUser('proj-1')).toBeUndefined()
      // Second call confirms the entry was deleted (not just hidden).
      nowSpy.mockReturnValue(base)
      expect(getProjectUser('proj-1')).toBeUndefined()
    })

    it('refreshes updatedAt on subsequent setProjectUser calls', () => {
      const base = 1_000_000_000_000
      nowSpy = spyOn(Date, 'now').mockReturnValue(base)
      setProjectUser('proj-1', 'user-1')
      nowSpy.mockReturnValue(base + HOUR_MS - 1)
      setProjectUser('proj-1', 'user-1')
      nowSpy.mockReturnValue(base + 2 * HOUR_MS - 2)
      expect(getProjectUser('proj-1')).toBe('user-1')
    })
  })
})

describe('getProjectOwnerUserId (DB fallback)', () => {
  let warnSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    mock.restore()
  })

  it('returns the workspace owner userId on success', async () => {
    mock.module('../prisma', () => ({
      prisma: {
        project: {
          findUnique: async () => ({
            workspace: { members: [{ userId: 'owner-123' }] },
          }),
        },
      },
    }))
    expect(await getProjectOwnerUserId('proj-1')).toBe('owner-123')
  })

  it("returns 'system' and warns when the project has no owner member", async () => {
    mock.module('../prisma', () => ({
      prisma: {
        project: {
          findUnique: async () => ({ workspace: { members: [] } }),
        },
      },
    }))
    expect(await getProjectOwnerUserId('proj-2')).toBe('system')
    expect(warnSpy).toHaveBeenCalled()
  })

  it("returns 'system' when the project is not found at all", async () => {
    mock.module('../prisma', () => ({
      prisma: {
        project: { findUnique: async () => null },
      },
    }))
    expect(await getProjectOwnerUserId('missing')).toBe('system')
    expect(warnSpy).toHaveBeenCalled()
  })

  it("returns 'system' and logs error when the DB query throws", async () => {
    mock.module('../prisma', () => ({
      prisma: {
        project: {
          findUnique: async () => {
            throw new Error('db connection lost')
          },
        },
      },
    }))
    expect(await getProjectOwnerUserId('proj-3')).toBe('system')
    expect(errorSpy).toHaveBeenCalled()
  })

  it("returns 'system' when workspace is missing on the project row", async () => {
    mock.module('../prisma', () => ({
      prisma: {
        project: { findUnique: async () => ({ workspace: null }) },
      },
    }))
    expect(await getProjectOwnerUserId('proj-4')).toBe('system')
    expect(warnSpy).toHaveBeenCalled()
  })
})
