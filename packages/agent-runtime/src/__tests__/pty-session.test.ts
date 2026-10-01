// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration tests for PtySession against a real /bin/sh PTY.
 *
 * We spawn an actual shell because (a) the whole point of the class is
 * the PTY-vs-pipe distinction and (b) Bun's terminal API is hard to
 * mock without re-implementing it. Tests are fast (a shell starts in a
 * few ms). The /bin/sh suite is POSIX-only because it relies on sh syntax;
 * the shell-neutral suites run on every platform through TEST_SHELL, and
 * the ConPTY suite at the bottom covers Windows with PowerShell.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { PtySession } from '../pty-session'
import { IS_WIN, SHELL_START_MS, TEST_SHELL, line, waitUntil, disposeAndRemove } from './helpers/pty-shell'

const SKIP = IS_WIN

describe('PtySession (real /bin/sh)', () => {
  if (SKIP) {
    test.skip('skipped on win32', () => {})
    return
  }

  let session: PtySession
  let workDir: string

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'pty-session-test-'))
    session = new PtySession({
      cmd: ['/bin/sh', '-i'],
      cwd: workDir,
      cols: 80,
      rows: 24,
      env: { PS1: 'PROMPT> ' },
      scrollbackBytes: 64 * 1024,
    })
    // Race-proof: wait for bash to print its first prompt before any test
    // writes anything. Otherwise our write() can land before the kernel
    // line discipline + bash startup converge, producing extra echo lines
    // (kernel echo + bash re-displaying prompt+line) that throw off
    // marker counts. Tests that don't care about counts can ignore this.
    await waitForFirstPrompt()
  })

  function waitForFirstPrompt(timeoutMs = 1500): Promise<void> {
    return new Promise<void>((resolve) => {
      let buf = ''
      const unsub = session.onData(({ bytes }) => {
        buf += new TextDecoder().decode(bytes)
        if (buf.includes('PROMPT> ')) {
          unsub()
          resolve()
        }
      })
      setTimeout(() => { unsub(); resolve() }, timeoutMs)
    })
  }

  afterEach(() => {
    session.dispose()
    rmSync(workDir, { recursive: true, force: true })
  })

  /**
   * Drain output until either `predicate(combined)` returns true or
   * `timeoutMs` elapses. Returns the combined string regardless. We
   * snapshot bytes via `onData` rather than `replaySince` so we test
   * the live-stream path.
   */
  function waitForOutput(
    predicate: (s: string) => boolean,
    timeoutMs = 2000,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let combined = ''
      const unsub = session.onData(({ bytes }) => {
        combined += new TextDecoder().decode(bytes)
        if (predicate(combined)) {
          unsub()
          resolve(combined)
        }
      })
      setTimeout(() => {
        unsub()
        resolve(combined)
      }, timeoutMs)
    })
  }

  /** Count non-overlapping occurrences of `re` in `s`. */
  function count(re: RegExp, s: string): number {
    return (s.match(new RegExp(re.source, re.flags.replace('g', '') + 'g')) ?? []).length
  }

  /**
   * The PTY echoes the typed command line back, so a marker appearing in
   * a command we sent will show up TWICE: once as echo, once as the real
   * output. Waiting for at least 2 occurrences avoids that race.
   */
  function waitForMarker(marker: string, timeoutMs = 2000): Promise<string> {
    const re = new RegExp(marker, 'g')
    return waitForOutput((s) => count(re, s) >= 2, timeoutMs)
  }

  test('starts with a real TTY: tty -s exits 0', async () => {
    // After waitForFirstPrompt(): bash is at its prompt, kernel echo and
    // shell display are in sync. Each marker now appears exactly once
    // from the kernel echo of the typed command line; the chosen branch
    // adds one more occurrence of its marker. END_MARKER is a "pipeline
    // really finished" sentinel so we don't sample mid-execution.
    session.write('tty -s && echo TTY_OK || echo TTY_BAD; echo END_MARKER\n')
    const out = await waitForOutput((s) => /\bEND_MARKER\b.*\bEND_MARKER\b/s.test(s), 3000)
    expect(count(/TTY_OK/, out)).toBe(2)
    expect(count(/TTY_BAD/, out)).toBe(1)
  })

  test('echoes typed bytes back via the data callback (POSIX line discipline)', async () => {
    session.write('echo hello-from-pty\n')
    const out = await waitForOutput((s) => s.includes('hello-from-pty'))
    expect(out).toContain('hello-from-pty')
  })

  test('persists cwd across writes — same shell, real cd', async () => {
    session.write(`cd "${workDir}" && pwd\n`)
    const out1 = await waitForOutput((s) => s.includes(workDir))
    expect(out1).toContain(workDir)

    // Issue a second command; the shell is still in the same dir.
    session.write('pwd\n')
    const out2 = await waitForOutput(
      (s) => (s.match(new RegExp(workDir, 'g'))?.length ?? 0) >= 1,
    )
    expect(out2).toContain(workDir)
  })

  test('persists env vars across writes', async () => {
    session.write('export FOO=bar123\n')
    await waitForOutput(() => true, 100) // give the shell a tick
    session.write('echo "FOO=$FOO"\n')
    const out = await waitForOutput((s) => s.includes('FOO=bar123'))
    expect(out).toContain('FOO=bar123')
  })

  test('side-effects work: writes a file in the work dir', async () => {
    // Wait for the marker to appear twice (echo + actual ack) so we know the
    // shell finished writing the file and not just typed-back our command.
    session.write(`echo touched > "${join(workDir, 'flag')}" && echo FLAG_WRITTEN\n`)
    await waitForMarker('FLAG_WRITTEN')
    expect(() => statSync(join(workDir, 'flag'))).not.toThrow()
  })

  test('resize() does not crash and updates cached dims', () => {
    session.resize(120, 40)
    expect(session.cols).toBe(120)
    expect(session.rows).toBe(40)
  })

  test('seqs are monotonic on the live stream', async () => {
    const seqs: number[] = []
    const unsub = session.onData(({ seq }) => seqs.push(seq))
    session.write('echo a; echo b; echo c\n')
    await new Promise((r) => setTimeout(r, 200))
    unsub()
    expect(seqs.length).toBeGreaterThan(0)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
  })

  test('replaySince(0) returns everything seen so far', async () => {
    session.write('echo before-replay\n')
    await waitForOutput((s) => s.includes('before-replay'))
    const replay = session.replaySince(0)
    expect(replay.truncated).toBe(false)
    expect(new TextDecoder().decode(replay.bytes)).toContain('before-replay')
    expect(replay.latestSeq).toBe(session.latestSeq)
  })

  test('replaySince(latestSeq) returns nothing', async () => {
    session.write('echo padding-out\n')
    await waitForOutput((s) => s.includes('padding-out'))
    const seq = session.latestSeq
    const replay = session.replaySince(seq)
    expect(replay.bytes.byteLength).toBe(0)
    expect(replay.latestSeq).toBe(seq)
  })

  test('signal("INT") interrupts the foreground process', async () => {
    // Use the prompt + an explicit echo *after* the sleep finishes as
    // success markers. On macOS /bin/sh is bash, where `sleep 30 || echo
    // INTERRUPTED` runs the `||` arm after SIGINT exits sleep non-zero.
    // On Ubuntu /bin/sh is dash, which treats SIGINT in an interactive
    // shell as "stop the whole command list and return to prompt", so
    // the `||` arm never runs — we'd never see INTERRUPTED. The robust
    // signal-handling guarantee is: SIGINT kills `sleep 30` within a
    // second or two, then we see the prompt come back and a subsequent
    // `echo` runs. Don't depend on `||` chain semantics.
    const t0 = Date.now()
    session.write('sleep 30 && echo SHOULD_NOT_PRINT\n')
    await new Promise((r) => setTimeout(r, 200))
    session.signal('INT')
    // Wait until the post-INT prompt reappears, then probe with a
    // sentinel echo so we know the shell is interactive again.
    await new Promise((r) => setTimeout(r, 250))
    session.write('echo INT_OK\n')
    const got = await waitForOutput((s) => /INT_OK|SHOULD_NOT_PRINT/.test(s), 5000)
    const elapsed = Date.now() - t0
    expect(got).toMatch(/INT_OK/)
    expect(got).not.toMatch(/SHOULD_NOT_PRINT\r?\n/)
    // Sanity: the sleep was interrupted long before its 30s natural end.
    expect(elapsed).toBeLessThan(10000)
  })

  test('exit propagates via onExit', async () => {
    const exitInfo = await new Promise<{ code: number | null }>((resolve) => {
      session.onExit((info) => resolve(info))
      session.write('exit 7\n')
    })
    expect(exitInfo.code).toBe(7)
    expect(session.isExited).toBe(true)
  })

  test('write() after dispose is a no-op', () => {
    session.dispose()
    expect(() => session.write('echo nope\n')).not.toThrow()
  })

  test('dispose is idempotent', () => {
    session.dispose()
    expect(() => session.dispose()).not.toThrow()
  })
})

// ─── v3 gap-close: defaultShellCmd branches + getter coverage ──────────────

import { _defaultShellCmdForTests } from '../pty-session'

describe('_defaultShellCmdForTests — shell detection branches', () => {
  const origShell = process.env.SHELL
  const origPlatform = (process as any).platform

  afterEach(() => {
    if (origShell === undefined) delete process.env.SHELL
    else process.env.SHELL = origShell
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  test('win32: returns powershell', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const cmd = _defaultShellCmdForTests()
    expect(cmd[0]).toBe('powershell.exe')
    expect(cmd).toContain('-NoLogo')
  })

  test('zsh SHELL: returns shell with -i', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.SHELL = '/usr/bin/zsh'
    const cmd = _defaultShellCmdForTests()
    expect(cmd[0]).toBe('/usr/bin/zsh')
    expect(cmd).toContain('-i')
    expect(cmd).toHaveLength(2)
  })

  test('fish SHELL: returns shell with -i', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.SHELL = '/usr/bin/fish'
    const cmd = _defaultShellCmdForTests()
    expect(cmd[0]).toBe('/usr/bin/fish')
    expect(cmd).toContain('-i')
    expect(cmd).toHaveLength(2)
  })

  test('bash SHELL: returns shell with --norc --noprofile -i', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.SHELL = '/bin/bash'
    const cmd = _defaultShellCmdForTests()
    expect(cmd[0]).toBe('/bin/bash')
    expect(cmd).toContain('--norc')
    expect(cmd).toContain('--noprofile')
  })

  test('unrecognised / unset SHELL: falls back to /bin/bash', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    delete process.env.SHELL
    const cmd = _defaultShellCmdForTests()
    expect(cmd[0]).toBe('/bin/bash')
  })
})

describe('PtySession getters (v3 gap-close)', () => {
  let session: PtySession

  beforeEach(async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-getter-test-'))
    session = new PtySession({ cmd: TEST_SHELL, cwd: dir, cols: 80, rows: 24 })
  })
  afterEach(() => { session.dispose() })

  test('pid returns a number', () => {
    expect(typeof session.pid).toBe('number')
    expect(session.pid).toBeGreaterThan(0)
  })

  test('lastActivity returns a recent timestamp', () => {
    expect(session.lastActivity).toBeLessThanOrEqual(Date.now())
    expect(session.lastActivity).toBeGreaterThan(Date.now() - 5000)
  })

  test('scrollbackSize starts at 0', () => {
    expect(session.scrollbackSize).toBe(0)
  })

  test('exitInfo is null before exit', () => {
    expect(session.exitInfo).toBeNull()
    expect(session.isExited).toBe(false)
  })
})

describe('PtySession error-swallowing in listeners (v3 gap-close)', () => {
  test('onData throwing listener is swallowed — other listeners still fire', async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync, rmSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-catch-test-'))
    const session = new PtySession({ cmd: TEST_SHELL, cwd: dir, cols: 80, rows: 24 })
    try {
      let goodFired = false
      const unsub1 = session.onData(() => { throw new Error('listener boom') })
      const unsub2 = session.onData(() => { goodFired = true })
      session.write(line('echo hello'))
      await waitUntil(() => goodFired, SHELL_START_MS)
      expect(goodFired).toBe(true)
      unsub1()
      unsub2()
    } finally {
      await disposeAndRemove(session, dir)
    }
  }, 30_000)

  test('onExit throwing listener is swallowed — other listeners still fire', async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync, rmSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-exit-catch-test-'))
    const session = new PtySession({ cmd: TEST_SHELL, cwd: dir, cols: 80, rows: 24 })
    try {
      let goodFired = false
      session.onExit(() => { throw new Error('exit listener boom') })
      session.onExit(() => { goodFired = true })
      session.write(line('exit 0'))
      await waitUntil(() => goodFired, SHELL_START_MS)
      expect(goodFired).toBe(true)
    } finally {
      await disposeAndRemove(session, dir)
    }
  }, 30_000)
})

describe('PtySession late-onExit and unsubscribe lambdas (v3 gap-close)', () => {
  test('onExit called after exit fires callback via queueMicrotask and returns no-op unsub', async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync, rmSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-late-exit-test-'))
    const session = new PtySession({ cmd: TEST_SHELL, cwd: dir, cols: 80, rows: 24 })
    try {
      // Wait for exit first
      await new Promise<void>((resolve) => {
        session.onExit(() => resolve())
        session.write(line('exit 0'))
      })
      await new Promise((r) => setTimeout(r, 50))

      // Now register AFTER exit → fires via queueMicrotask, returns () => {}
      let lateFired = false
      const lateUnsub = session.onExit(() => { lateFired = true })
      await new Promise((r) => queueMicrotask(r as () => void))
      expect(lateFired).toBe(true)

      // Call the empty unsubscribe — covers the () => {} function body
      expect(() => lateUnsub()).not.toThrow()
    } finally {
      await disposeAndRemove(session, dir)
    }
  }, 30_000)

  test('onExit unsubscribe called before exit removes the listener', async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync, rmSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-unsub-exit-test-'))
    const session = new PtySession({ cmd: TEST_SHELL, cwd: dir, cols: 80, rows: 24 })
    try {
      let fired = false
      const unsub = session.onExit(() => { fired = true })
      // Unsubscribe BEFORE exit — covers the delete lambda at line 240
      unsub()
      await new Promise<void>((resolve) => {
        session.onExit(() => resolve())
        session.write(line('exit 0'))
      })
      await new Promise((r) => setTimeout(r, 50))
      // The unsubscribed listener should NOT have fired
      expect(fired).toBe(false)
    } finally {
      await disposeAndRemove(session, dir)
    }
  }, 30_000)
})

describe('PtySession on Windows (real ConPTY + PowerShell)', () => {
  if (!IS_WIN) {
    test.skip('Windows-only; POSIX is covered by the /bin/sh suite above', () => {})
    return
  }

  let session: PtySession
  let workDir: string
  let output = ''

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'pty-conpty-test-'))
    output = ''
    session = new PtySession({ cmd: TEST_SHELL, cwd: workDir, cols: 80, rows: 24 })
    session.onData(({ bytes }) => { output += new TextDecoder().decode(bytes) })
  })

  afterEach(async () => {
    await disposeAndRemove(session, workDir)
  })

  async function until(predicate: () => boolean, timeoutMs = SHELL_START_MS): Promise<void> {
    const t0 = Date.now()
    while (!predicate()) {
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`timed out after ${timeoutMs}ms; output=${JSON.stringify(output.slice(-400))}`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  const occurrences = (marker: string) => output.split(marker).length - 1

  test('spawns a shell and round-trips a command through ConPTY', async () => {
    expect(session.pid).toBeGreaterThan(0)
    session.write(line('echo conpty-hello'))
    // Once as the echoed command line, once as the command's output.
    await until(() => occurrences('conpty-hello') >= 2)
  }, 30_000)

  test('starts in the requested cwd and keeps state between commands', async () => {
    session.write(line('$env:SHOGO_PTY_TEST = "kept-" + (Get-Location).Path.Length'))
    session.write(line('echo "STATE=$env:SHOGO_PTY_TEST"'))
    await until(() => /STATE=kept-\d+/.test(output))
    session.write(line('(Get-Location).Path'))
    const leaf = workDir.split(/[\\/]/).pop()!
    await until(() => occurrences(leaf) >= 1)
  }, 30_000)

  test('resize() is accepted by the pseudoconsole', async () => {
    session.resize(132, 50)
    expect(session.cols).toBe(132)
    expect(session.rows).toBe(50)
    session.write(line('echo after-resize'))
    await until(() => occurrences('after-resize') >= 2)
  }, 30_000)

  test('scrollback replay returns output emitted before the reader attached', async () => {
    session.write(line('echo replay-marker'))
    await until(() => occurrences('replay-marker') >= 2)
    const replay = session.replaySince(0)
    expect(replay.truncated).toBe(false)
    expect(new TextDecoder().decode(replay.bytes)).toContain('replay-marker')
    expect(replay.latestSeq).toBe(session.latestSeq)
  }, 30_000)

  test('exit code propagates via onExit', async () => {
    const exited = new Promise<{ code: number | null }>((resolve) => session.onExit(resolve))
    session.write(line('exit 7'))
    const info = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no exit')), SHELL_START_MS)),
    ])
    expect(info.code).toBe(7)
    expect(session.isExited).toBe(true)
  }, 30_000)

  test('dispose() reaps a running shell promptly', async () => {
    session.write(line('echo ready-to-kill'))
    await until(() => occurrences('ready-to-kill') >= 2)
    const pid = session.pid!
    session.dispose()
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    const t0 = Date.now()
    while (alive() && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 100))
    expect(alive()).toBe(false)
  }, 30_000)
})
