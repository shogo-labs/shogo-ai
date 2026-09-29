// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { SSHAskpassBroker } from './askpass'

describe('SSHAskpassBroker', () => {
  test('creates a private, unpredictable directory and helper', () => {
    const first = new SSHAskpassBroker()
    const second = new SSHAskpassBroker()
    try {
      expect(first.directory).not.toBe(second.directory)
      expect(statSync(first.directory).mode & 0o777).toBe(0o700)
      expect(existsSync(first.helperPath)).toBe(true)
      expect(first.environment().SSH_ASKPASS).toBe(first.helperPath)
      expect(first.environment().SSH_ASKPASS_REQUIRE).toBe('force')
      expect(first.getPrompt()).toBeNull()
    } finally {
      first.close()
      second.close()
    }
    expect(existsSync(first.directory)).toBe(false)
  })

  test('reports the prompt time from the prompt file and publishes answers atomically', () => {
    const broker = new SSHAskpassBroker()
    try {
      writeFileSync(`${broker.directory}/prompt`, 'Enter passphrase:')
      const prompt = broker.getPrompt()
      expect(prompt?.prompt).toBe('Enter passphrase:')
      expect(prompt?.createdAt).toBe(statSync(`${broker.directory}/prompt`).mtimeMs)

      broker.respond('secret')
      expect(readFileSync(`${broker.directory}/response`, 'utf8')).toBe('secret')
      expect(existsSync(`${broker.directory}/response.tmp`)).toBe(false)
    } finally {
      broker.close()
    }
  })

  test('relays a prompt through the helper script end to end', async () => {
    const broker = new SSHAskpassBroker()
    try {
      const child = spawn(broker.helperPath, ['Password:'], {
        env: { ...process.env, ...broker.environment() },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      const exited = new Promise<number | null>((resolve) => child.once('close', resolve))

      for (let i = 0; i < 50 && !broker.getPrompt(); i++) await Bun.sleep(20)
      expect(broker.getPrompt()?.prompt).toBe('Password:')
      broker.respond('hunter2')

      expect(await exited).toBe(0)
      expect(stdout).toBe('hunter2')
      expect(broker.getPrompt()).toBeNull()
    } finally {
      broker.close()
    }
  })

  test('rejects multiline answers and ignores prompts after close', () => {
    const broker = new SSHAskpassBroker()
    expect(() => broker.respond('a\nb')).toThrow('single line')
    broker.close()
    expect(broker.getPrompt()).toBeNull()
    expect(() => broker.respond('secret')).toThrow('closed')
  })
})
