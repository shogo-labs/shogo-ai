// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { SSHAskpassBroker } from './askpass'

describe('SSHAskpassBroker', () => {
  test('creates a private helper and relays a prompt response', () => {
    const broker = new SSHAskpassBroker('unit-test')
    try {
      expect(existsSync(broker.helperPath)).toBe(true)
      expect(broker.environment().SSH_ASKPASS).toBe(broker.helperPath)
      expect(broker.environment().SSH_ASKPASS_REQUIRE).toBe('force')
      expect(broker.getPrompt()).toBeNull()

      readFileSync(broker.helperPath, 'utf8')
      broker.respond('secret')
      expect(readFileSync(`${broker.directory}/response`, 'utf8')).toBe('secret')
    } finally {
      broker.close()
    }
    expect(existsSync(broker.directory)).toBe(false)
  })

  test('rejects multiline answers and ignores prompts after close', () => {
    const broker = new SSHAskpassBroker('unit-test-validation')
    expect(() => broker.respond('a\nb')).toThrow('single line')
    broker.close()
    expect(broker.getPrompt()).toBeNull()
    expect(() => broker.respond('secret')).toThrow('closed')
  })
})
