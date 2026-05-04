// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { prepareTerminalPtyUpgrade } from '../routes/terminal-pty-proxy'

describe('terminal-pty-proxy', () => {
  test('ignores unrelated websocket paths', async () => {
    const result = await prepareTerminalPtyUpgrade(new Request('http://api.test/api/instances/ws'))
    expect(result).toBeNull()
  })

  test('requires websocket upgrade for PTY path', async () => {
    const result = await prepareTerminalPtyUpgrade(new Request('http://api.test/api/projects/p1/terminal/pty'))
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(426)
  })

  test('requires Origin in production when an allowlist is configured', async () => {
    const previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
      SHOGO_LOCAL_MODE: process.env.SHOGO_LOCAL_MODE,
    }
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://studio.example.com'
    process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      const result = await prepareTerminalPtyUpgrade(new Request('http://api.test/api/projects/p1/terminal/pty', {
        headers: { upgrade: 'websocket' },
      }))
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(403)
    } finally {
      if (previousEnv.NODE_ENV === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousEnv.NODE_ENV
      if (previousEnv.ALLOWED_ORIGINS === undefined) delete process.env.ALLOWED_ORIGINS
      else process.env.ALLOWED_ORIGINS = previousEnv.ALLOWED_ORIGINS
      if (previousEnv.SHOGO_LOCAL_MODE === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = previousEnv.SHOGO_LOCAL_MODE
    }
  })

  test('disables PTY websocket proxy outside Shogo Desktop local mode', async () => {
    const previousLocalMode = process.env.SHOGO_LOCAL_MODE
    delete process.env.SHOGO_LOCAL_MODE
    try {
      const result = await prepareTerminalPtyUpgrade(new Request('http://api.test/api/projects/p1/terminal/pty', {
        headers: { upgrade: 'websocket' },
      }))
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(404)
    } finally {
      if (previousLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = previousLocalMode
    }
  })
})
