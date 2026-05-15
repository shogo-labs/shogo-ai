// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// Mock prisma BEFORE importing the module under test — getProjectOwnerUserId
// uses a dynamic `import('./prisma')` so this needs to be in place first.
const findUniqueMock = mock(
  async (_args: any): Promise<any> => null
)
mock.module('../lib/prisma', () => ({
  prisma: {
    project: { findUnique: findUniqueMock },
  },
}))

// Import after mocking.
import {
  getProjectOwnerUserId,
  getProjectUser,
  setProjectUser,
} from '../lib/project-user-context'

beforeEach(() => {
  // The module owns a process-global Map. We can't reset it directly, so we
  // use distinct projectIds per test to avoid cross-contamination.
  findUniqueMock.mockReset()
  findUniqueMock.mockImplementation(async () => null)
})

describe('setProjectUser / getProjectUser', () => {
  test('returns undefined when no context has been set', () => {
    expect(getProjectUser('proj_unknown_1')).toBeUndefined()
  })

  test('round-trips a userId for a project', () => {
    setProjectUser('proj_rt_1', 'user_alice')
    expect(getProjectUser('proj_rt_1')).toBe('user_alice')
  })

  test('isolates contexts across projects', () => {
    setProjectUser('proj_iso_a', 'user_a')
    setProjectUser('proj_iso_b', 'user_b')
    expect(getProjectUser('proj_iso_a')).toBe('user_a')
    expect(getProjectUser('proj_iso_b')).toBe('user_b')
  })

  test('overwrites the userId for the same project on a subsequent set', () => {
    setProjectUser('proj_overwrite', 'user_first')
    setProjectUser('proj_overwrite', 'user_second')
    expect(getProjectUser('proj_overwrite')).toBe('user_second')
  })

  test('expires entries older than 1 hour and deletes them on read', () => {
    setProjectUser('proj_expire', 'user_expiring')
    expect(getProjectUser('proj_expire')).toBe('user_expiring')

    // Fast-forward Date.now beyond the 1-hour TTL.
    const realNow = Date.now
    const spy = spyOn(Date, 'now').mockImplementation(() => realNow() + 61 * 60 * 1000)
    try {
      expect(getProjectUser('proj_expire')).toBeUndefined()
    } finally {
      spy.mockRestore()
    }

    // After expiry the entry should be evicted: even with normal clock the
    // result must remain undefined until set again.
    expect(getProjectUser('proj_expire')).toBeUndefined()
  })

  test('does NOT expire entries within the 1-hour window', () => {
    setProjectUser('proj_within', 'user_within')
    const realNow = Date.now
    // 59 minutes — still inside the TTL.
    const spy = spyOn(Date, 'now').mockImplementation(() => realNow() + 59 * 60 * 1000)
    try {
      expect(getProjectUser('proj_within')).toBe('user_within')
    } finally {
      spy.mockRestore()
    }
  })

  test('a refresh via setProjectUser resets the TTL', () => {
    setProjectUser('proj_refresh', 'user_v1')

    const realNow = Date.now
    // Jump forward 30 minutes, then refresh.
    let offset = 30 * 60 * 1000
    const spy = spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    try {
      setProjectUser('proj_refresh', 'user_v2')
      // Now jump another 50 minutes (80 total from original set). Without
      // the refresh this would have expired; with it, still within TTL.
      offset = 80 * 60 * 1000
      expect(getProjectUser('proj_refresh')).toBe('user_v2')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('getProjectOwnerUserId', () => {
  test('returns the workspace owner userId on a successful lookup', async () => {
    findUniqueMock.mockImplementation(async () => ({
      workspace: { members: [{ userId: 'user_owner' }] },
    }))

    const result = await getProjectOwnerUserId('proj_owner_lookup')
    expect(result).toBe('user_owner')
    expect(findUniqueMock).toHaveBeenCalledTimes(1)
  })

  test('queries prisma with the correct project id and owner-role selector', async () => {
    findUniqueMock.mockImplementation(async () => ({
      workspace: { members: [{ userId: 'user_owner_2' }] },
    }))

    await getProjectOwnerUserId('proj_query_shape')

    const callArgs = findUniqueMock.mock.calls[0][0]
    expect(callArgs.where).toEqual({ id: 'proj_query_shape' })
    // The select narrows to owner-role members only — that's the security
    // contract for long-lived proxy tokens.
    expect(callArgs.select.workspace.select.members.where).toEqual({ role: 'owner' })
    expect(callArgs.select.workspace.select.members.take).toBe(1)
  })

  test("falls back to 'system' when the project is not found", async () => {
    findUniqueMock.mockImplementation(async () => null)
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await getProjectOwnerUserId('proj_missing')
      expect(result).toBe('system')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("falls back to 'system' when the workspace has no owner member", async () => {
    findUniqueMock.mockImplementation(async () => ({
      workspace: { members: [] },
    }))
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await getProjectOwnerUserId('proj_no_owner')
      expect(result).toBe('system')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("falls back to 'system' when workspace is null", async () => {
    findUniqueMock.mockImplementation(async () => ({ workspace: null }))
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await getProjectOwnerUserId('proj_no_workspace')).toBe('system')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("catches DB errors and falls back to 'system'", async () => {
    findUniqueMock.mockImplementation(async () => {
      throw new Error('connection refused')
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await getProjectOwnerUserId('proj_db_error')
      expect(result).toBe('system')
      expect(errorSpy).toHaveBeenCalledTimes(1)
      // Error path logs the project id and the message.
      const logged = errorSpy.mock.calls[0].join(' ')
      expect(logged).toContain('proj_db_error')
      expect(logged).toContain('connection refused')
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('a thrown non-Error value is still handled gracefully', async () => {
    findUniqueMock.mockImplementation(async () => {
      // Some drivers throw non-Error objects; the implementation reads
      // `err.message` so a plain object with `message` must also work.
      throw { message: 'plain object failure' }
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await getProjectOwnerUserId('proj_weird_throw')).toBe('system')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
