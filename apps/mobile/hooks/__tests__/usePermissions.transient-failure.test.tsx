// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A permissions fetch that dies on the wire must never be cached as "no access".
 *
 * Regression guard for the canvas composer flipping to "You have view-only
 * access to this project" after a brief network drop: the aborted /permissions
 * request was cached as an empty permission set, so `projectReadOnly` became
 * true and the user could not send a message until the cache went stale.
 */

import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, renderHook, waitFor } from '@testing-library/react'

type FetchResult = { permissions?: string[]; workspaceRole?: string } | Error

let http: object
let nextResult: () => Promise<FetchResult> = async () => ({ permissions: [] })

mock.module(resolve(import.meta.dir, '../../contexts/domain'), () => ({
  useDomainHttp: () => http,
}))

mock.module(resolve(import.meta.dir, '../../lib/api'), () => ({
  api: {
    getProjectPermissions: mock(async () => {
      const result = await nextResult()
      if (result instanceof Error) throw result
      return result
    }),
    getWorkspacePermissions: mock(async () => {
      const result = await nextResult()
      if (result instanceof Error) throw result
      return result
    }),
  },
}))

const { usePermissions, isAccessDenial, PERMISSIONS_RETRY_MS } = await import('../usePermissions')

function networkError() {
  const error = new Error('Network request failed') as Error & { code: string }
  error.code = 'NETWORK_ERROR'
  return error
}

function httpStatus(status: number) {
  const error = new Error(`Request failed with status ${status}`) as Error & { status: number }
  error.status = status
  return error
}

let projectSeq = 0
function freshProjectId() {
  projectSeq += 1
  return `perm-test-${projectSeq}-${Date.now()}`
}

beforeEach(() => {
  http = {}
  nextResult = async () => ({ permissions: [] })
})

describe('usePermissions under a dropped connection', () => {
  test('keeps the previously known permissions instead of going read-only', async () => {
    nextResult = async () => ({ permissions: ['project:update'], workspaceRole: 'owner' })
    const projectId = freshProjectId()

    const { result } = renderHook(() => usePermissions({ projectId }))
    await waitFor(() => expect(result.current.can('project:update')).toBe(true))

    nextResult = async () => networkError()
    await act(async () => {
      await result.current.refetch()
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.can('project:update')).toBe(true)
    expect(result.current.workspaceRole).toBe('owner')
  })

  test('stays in the loading state (not view-only) when the very first fetch drops', async () => {
    nextResult = async () => networkError()
    const projectId = freshProjectId()

    const { result } = renderHook(() => usePermissions({ projectId }))
    await waitFor(() => expect(result.current.loading).toBe(true))

    expect(result.current.can('project:update')).toBe(false)
    // `projectReadOnly` in the canvas layout is `!loading && !can(...)`, so a
    // still-loading scope must keep the composer usable rather than disabled.
    expect(result.current.loading).toBe(true)
  })

  test('a 403 from the server still means no access', async () => {
    nextResult = async () => httpStatus(403)
    const projectId = freshProjectId()

    const { result } = renderHook(() => usePermissions({ projectId }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.can('project:update')).toBe(false)
  })

  test('recovers on the next attempt once the network is back', async () => {
    nextResult = async () => networkError()
    const projectId = freshProjectId()

    const { result } = renderHook(() => usePermissions({ projectId }))
    await waitFor(() => expect(result.current.loading).toBe(true))

    nextResult = async () => ({ permissions: ['project:update'] })
    await act(async () => {
      await result.current.refetch()
    })

    await waitFor(() => expect(result.current.can('project:update')).toBe(true))
  })
})

describe('isAccessDenial', () => {
  test('treats 401/403/404 as a denial', () => {
    expect(isAccessDenial(httpStatus(401))).toBe(true)
    expect(isAccessDenial(httpStatus(403))).toBe(true)
    expect(isAccessDenial(httpStatus(404))).toBe(true)
  })

  test('treats transport failures and server errors as transient', () => {
    expect(isAccessDenial(networkError())).toBe(false)
    expect(isAccessDenial(httpStatus(500))).toBe(false)
    const abort = new Error('The operation was aborted.') as Error & { name: string }
    abort.name = 'AbortError'
    expect(isAccessDenial(abort)).toBe(false)
    expect(isAccessDenial(new TypeError('Failed to fetch'))).toBe(false)
    expect(isAccessDenial(null)).toBe(false)
    expect(isAccessDenial(undefined)).toBe(false)
  })

  test('falls back to the error code when no status is attached', () => {
    expect(isAccessDenial({ code: 'FORBIDDEN' })).toBe(true)
    expect(isAccessDenial({ code: 'NETWORK_ERROR' })).toBe(false)
  })
})

describe('PERMISSIONS_RETRY_MS', () => {
  test('is a short, bounded backoff', () => {
    expect(PERMISSIONS_RETRY_MS).toBeGreaterThan(0)
    expect(PERMISSIONS_RETRY_MS).toBeLessThanOrEqual(30_000)
  })
})
