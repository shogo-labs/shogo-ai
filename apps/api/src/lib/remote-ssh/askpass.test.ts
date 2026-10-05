// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

  test('writes a native .cmd + PowerShell helper on win32', () => {
    const broker = new SSHAskpassBroker({ platform: 'win32' })
    try {
      expect(broker.helperPath).toBe(join(broker.directory, 'askpass.cmd'))
      expect(broker.environment().SSH_ASKPASS).toBe(broker.helperPath)
      const cmd = readFileSync(broker.helperPath, 'utf8')
      expect(cmd.startsWith('#!')).toBe(false)
      expect(cmd).toContain('powershell.exe')
      expect(cmd).toContain('%~dp0askpass.ps1')
      expect(cmd).toContain('%*')
      const ps1 = readFileSync(join(broker.directory, 'askpass.ps1'), 'utf8')
      expect(ps1).toContain('SHOGO_ASKPASS_DIR')
      expect(ps1).toContain('Move-Item')
      // The multi-line prompt recovery reads the parent cmd.exe command line.
      expect(ps1).toContain('Win32_Process')
      expect(existsSync(join(broker.directory, 'askpass.sh'))).toBe(false)
    } finally {
      broker.close()
    }
  })

  describe('secret cache', () => {
    const prompt = (broker: SSHAskpassBroker, text: string, pid?: string) => {
      rmSync(join(broker.directory, 'response'), { force: true })
      if (pid !== undefined) writeFileSync(join(broker.directory, 'prompt.pid'), pid)
      writeFileSync(join(broker.directory, 'prompt'), text)
    }
    const consume = (broker: SSHAskpassBroker) => {
      const answer = readFileSync(join(broker.directory, 'response'), 'utf8')
      rmSync(join(broker.directory, 'prompt'), { force: true })
      rmSync(join(broker.directory, 'response'), { force: true })
      return answer
    }
    const make = () => new SSHAskpassBroker({ cacheSecrets: true, pollIntervalMs: 1_000_000 })

    test('answers a remembered password prompt and hides it from the UI', () => {
      const broker = make()
      try {
        prompt(broker, 'alice@example.com\'s password: ', '100')
        expect(broker.getPrompt()?.prompt).toContain('password')
        broker.respond('hunter2')
        expect(consume(broker)).toBe('hunter2')

        // A new ssh process asks the identical question.
        prompt(broker, 'alice@example.com\'s password: ', '200')
        expect(broker.getPrompt()).toBeNull()
        broker.answerCachedPrompt()
        expect(consume(broker)).toBe('hunter2')
      } finally {
        broker.close()
      }
    })

    test('the poll timer answers remembered prompts on its own', async () => {
      const broker = new SSHAskpassBroker({ cacheSecrets: true, pollIntervalMs: 5 })
      try {
        prompt(broker, 'Enter passphrase for key \'id_ed25519\': ', '1')
        broker.respond('open sesame')
        consume(broker)

        prompt(broker, 'Enter passphrase for key \'id_ed25519\': ', '2')
        for (let i = 0; i < 100 && !existsSync(join(broker.directory, 'response')); i++) await Bun.sleep(5)
        expect(readFileSync(join(broker.directory, 'response'), 'utf8')).toBe('open sesame')
      } finally {
        broker.close()
      }
    })

    test('different prompts are not answered from the cache', () => {
      const broker = make()
      try {
        prompt(broker, 'alice@a.example\'s password: ')
        broker.respond('one')
        consume(broker)

        prompt(broker, 'alice@b.example\'s password: ')
        broker.answerCachedPrompt()
        expect(existsSync(join(broker.directory, 'response'))).toBe(false)
        expect(broker.getPrompt()?.prompt).toBe('alice@b.example\'s password: ')
      } finally {
        broker.close()
      }
    })

    test('a rejected secret (same ssh process asks again) is dropped and the user is asked', () => {
      const broker = make()
      try {
        prompt(broker, 'Password: ', '100')
        broker.respond('wrong')
        consume(broker)

        prompt(broker, 'Password: ', '200')
        broker.answerCachedPrompt()
        expect(consume(broker)).toBe('wrong')

        // ssh pid 200 rejected it and asks again.
        prompt(broker, 'Password: ', '200')
        broker.answerCachedPrompt()
        expect(existsSync(join(broker.directory, 'response'))).toBe(false)
        expect(broker.getPrompt()?.prompt).toBe('Password: ')

        // The corrected answer is remembered instead.
        broker.respond('right')
        consume(broker)
        prompt(broker, 'Password: ', '300')
        broker.answerCachedPrompt()
        expect(consume(broker)).toBe('right')
      } finally {
        broker.close()
      }
    })

    test('back-to-back commands from new processes do not count as rejections', () => {
      const broker = make()
      try {
        prompt(broker, 'Password: ', '1')
        broker.respond('pw')
        consume(broker)
        for (const pid of ['2', '3', '4']) {
          prompt(broker, 'Password: ', pid)
          broker.answerCachedPrompt()
          expect(consume(broker)).toBe('pw')
        }
      } finally {
        broker.close()
      }
    })

    test('without a pid, an immediate repeat is treated as a rejection', () => {
      const broker = make()
      try {
        prompt(broker, 'Password: ')
        broker.respond('wrong')
        consume(broker)
        prompt(broker, 'Password: ')
        broker.answerCachedPrompt()
        consume(broker)

        prompt(broker, 'Password: ')
        broker.answerCachedPrompt()
        expect(existsSync(join(broker.directory, 'response'))).toBe(false)
        expect(broker.getPrompt()).not.toBeNull()
      } finally {
        broker.close()
      }
    })

    test('never remembers host-key confirmations or one-time codes', () => {
      const broker = make()
      try {
        const hostKey =
          'The authenticity of host \'example.com\' can\'t be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? '
        prompt(broker, hostKey)
        broker.respond('yes')
        consume(broker)
        prompt(broker, hostKey)
        broker.answerCachedPrompt()
        expect(existsSync(join(broker.directory, 'response'))).toBe(false)
        expect(broker.getPrompt()?.prompt).toBe(hostKey)
        rmSync(join(broker.directory, 'prompt'))

        const otp = '(alice@example.com) One-time password: '
        prompt(broker, otp)
        broker.respond('123456')
        consume(broker)
        prompt(broker, otp)
        broker.answerCachedPrompt()
        expect(existsSync(join(broker.directory, 'response'))).toBe(false)
        expect(broker.getPrompt()?.prompt).toBe(otp)
      } finally {
        broker.close()
      }
    })

    test('does not remember anything unless caching is enabled', () => {
      const broker = new SSHAskpassBroker()
      try {
        prompt(broker, 'Password: ')
        broker.respond('pw')
        consume(broker)
        prompt(broker, 'Password: ')
        broker.answerCachedPrompt()
        expect(existsSync(join(broker.directory, 'response'))).toBe(false)
        expect(broker.getPrompt()?.prompt).toBe('Password: ')
      } finally {
        broker.close()
      }
    })

    test('close() forgets remembered secrets', () => {
      const broker = make()
      prompt(broker, 'Password: ')
      broker.respond('pw')
      broker.close()
      expect(broker.getPrompt()).toBeNull()
      broker.answerCachedPrompt()
      expect(existsSync(broker.directory)).toBe(false)
    })
  })

  test('rejects multiline answers and ignores prompts after close', () => {
    const broker = new SSHAskpassBroker()
    expect(() => broker.respond('a\nb')).toThrow('single line')
    broker.close()
    expect(broker.getPrompt()).toBeNull()
    expect(() => broker.respond('secret')).toThrow('closed')
  })
})
