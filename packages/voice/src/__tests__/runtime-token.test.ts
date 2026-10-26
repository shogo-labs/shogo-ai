// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-228: a `wrt_v1_` token in `RUNTIME_AUTH_SECRET` is the workspace runtime
 * token, not the project's. It cannot authenticate a single SDK call, so the
 * readers refuse it up front with a message that names the real fix instead of
 * letting every request fail with a bare 401.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readRuntimeAuthSecret, WORKSPACE_RUNTIME_TOKEN_MESSAGE } from '../runtime-token'
import { createVoiceHandlers } from '../server'

const WORKSPACE_TOKEN = 'wrt_v1_ws-1_workspacehmac'
const PROJECT_TOKEN = 'rt_v1_proj-a_projecthmac'

const SAVED = new Map<string, string | undefined>()

function setEnv(key: string, value: string | undefined): void {
  if (!SAVED.has(key)) SAVED.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  setEnv('RUNTIME_AUTH_SECRET', undefined)
  setEnv('PROJECT_ID', undefined)
})

afterEach(() => {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  SAVED.clear()
})

describe('readRuntimeAuthSecret', () => {
  test('returns the project token', () => {
    setEnv('RUNTIME_AUTH_SECRET', PROJECT_TOKEN)
    expect(readRuntimeAuthSecret()).toBe(PROJECT_TOKEN)
  })

  test('is undefined when the pod injected nothing', () => {
    expect(readRuntimeAuthSecret()).toBeUndefined()
    expect(readRuntimeAuthSecret({})).toBeUndefined()
  })

  test('refuses the workspace token with the actionable message', () => {
    setEnv('RUNTIME_AUTH_SECRET', WORKSPACE_TOKEN)
    expect(() => readRuntimeAuthSecret()).toThrow(WORKSPACE_RUNTIME_TOKEN_MESSAGE)
    expect(WORKSPACE_RUNTIME_TOKEN_MESSAGE).toContain('rt_v1_')
    expect(WORKSPACE_RUNTIME_TOKEN_MESSAGE).toContain('preview')
  })
})

describe('createVoiceHandlers', () => {
  test('fails fast on a workspace token instead of 401ing on every op', () => {
    setEnv('RUNTIME_AUTH_SECRET', WORKSPACE_TOKEN)
    setEnv('PROJECT_ID', 'proj-a')
    setEnv('SHOGO_API_URL', 'https://api.example')

    expect(() => createVoiceHandlers({})).toThrow(WORKSPACE_RUNTIME_TOKEN_MESSAGE)
  })

  test('still detects proxy mode from a project token', async () => {
    setEnv('RUNTIME_AUTH_SECRET', PROJECT_TOKEN)
    setEnv('PROJECT_ID', 'proj-a')
    setEnv('SHOGO_API_URL', 'https://api.example')

    const handlers = createVoiceHandlers({ fetch: async () => new Response('{}') })
    // The static catalog needs no credentials at all — a handler exists, so
    // construction did not throw.
    expect(typeof handlers.op).toBe('function')
  })
})
