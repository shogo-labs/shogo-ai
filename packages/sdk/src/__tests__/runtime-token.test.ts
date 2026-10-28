// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-228: the SDK reads `RUNTIME_AUTH_SECRET` through one shared reader
 * (`@shogo-ai/voice`), which refuses a workspace runtime token (`wrt_v1_…`).
 * App code that inherited the workspace token used to get a bare 401 from every
 * surface; now it gets one error that names the fix.
 *
 *   bun test packages/sdk/src/__tests__/runtime-token.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createClient } from '../client'
import { _resetServerToolsClientForTests, getServerToolsClient } from '../tools/client'
import { createToolsHandlers } from '../tools/server'
import { readRuntimeAuthSecret, WORKSPACE_RUNTIME_TOKEN_MESSAGE } from '../runtime-token'

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
  setEnv('RUNTIME_PORT', undefined)
  setEnv('PROJECT_ID', undefined)
})

afterEach(() => {
  // The server tools client is a module singleton; leave it as we found it so
  // the next file in this `bun test` process derives its own from env.
  _resetServerToolsClientForTests()
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  SAVED.clear()
})

describe('shared runtime-token reader', () => {
  test('re-exports the voice implementation, not a second copy', () => {
    setEnv('RUNTIME_AUTH_SECRET', PROJECT_TOKEN)
    expect(readRuntimeAuthSecret()).toBe(PROJECT_TOKEN)
    expect(WORKSPACE_RUNTIME_TOKEN_MESSAGE).toContain('rt_v1_')
  })
})

describe('a workspace token fails fast', () => {
  test('createClient() refuses it for client.llm', () => {
    setEnv('RUNTIME_AUTH_SECRET', WORKSPACE_TOKEN)
    expect(() =>
      createClient({ apiUrl: 'http://api.test', db: {} as any, projectId: 'proj-a' }),
    ).toThrow(WORKSPACE_RUNTIME_TOKEN_MESSAGE)
  })

  test('getServerToolsClient() refuses it', () => {
    setEnv('RUNTIME_AUTH_SECRET', WORKSPACE_TOKEN)
    setEnv('RUNTIME_PORT', '8080')
    expect(() => getServerToolsClient()).toThrow(WORKSPACE_RUNTIME_TOKEN_MESSAGE)
  })

  test('createToolsHandlers() refuses it', () => {
    setEnv('RUNTIME_AUTH_SECRET', WORKSPACE_TOKEN)
    setEnv('RUNTIME_PORT', '8080')
    expect(() => createToolsHandlers()).toThrow(WORKSPACE_RUNTIME_TOKEN_MESSAGE)
  })
})

describe('a project token still works', () => {
  test('createClient() wires client.llm', () => {
    setEnv('RUNTIME_AUTH_SECRET', PROJECT_TOKEN)
    const client = createClient({ apiUrl: 'http://api.test', db: {} as any, projectId: 'proj-a' })
    expect(client.llm).not.toBeNull()
  })

  test('getServerToolsClient() builds a client for the runtime port', () => {
    setEnv('RUNTIME_AUTH_SECRET', PROJECT_TOKEN)
    setEnv('RUNTIME_PORT', '8080')
    const tools = getServerToolsClient()
    expect(typeof tools.execute).toBe('function')
  })
})
