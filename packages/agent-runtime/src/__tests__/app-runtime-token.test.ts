// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetAppRuntimeTokensForTests,
  fetchAppRuntimeToken,
  isAppRuntimeToken,
} from '../app-runtime-token'

let calls: string[] = []
let respond: () => Response
const request = async (path: string) => {
  calls.push(path)
  return respond()
}

beforeEach(() => {
  _resetAppRuntimeTokensForTests()
  calls = []
})

describe('app-runtime-token', () => {
  test('fetches the project token once and recognises it afterwards', async () => {
    respond = () => Response.json({ projectId: 'p1', token: 'rt_v1_p1_tok' })
    expect(isAppRuntimeToken('rt_v1_p1_tok')).toBe(false)

    expect(await fetchAppRuntimeToken('p1', request)).toBe('rt_v1_p1_tok')
    expect(await fetchAppRuntimeToken('p1', request)).toBe('rt_v1_p1_tok')

    expect(calls).toEqual(['/api/internal/projects/p1/app-runtime-token'])
    expect(isAppRuntimeToken('rt_v1_p1_tok')).toBe(true)
    expect(isAppRuntimeToken('rt_v1_p2_tok')).toBe(false)
    expect(isAppRuntimeToken('')).toBe(false)
  })

  test('returns null and caches nothing when the API refuses', async () => {
    respond = () => Response.json({ error: 'Unauthorized' }, { status: 401 })
    expect(await fetchAppRuntimeToken('p1', request)).toBeNull()

    respond = () => Response.json({ projectId: 'p1', token: 'rt_v1_p1_tok' })
    expect(await fetchAppRuntimeToken('p1', request)).toBe('rt_v1_p1_tok')
    expect(calls).toHaveLength(2)
  })

  test('returns null when the request throws', async () => {
    respond = () => { throw new Error('network down') }
    expect(await fetchAppRuntimeToken('p1', request)).toBeNull()
  })
})
