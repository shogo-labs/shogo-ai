// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration tests for PtySession against a real /bin/sh PTY.
 *
 * We spawn an actual shell because (a) the whole point of the class is
 * the PTY-vs-pipe distinction and (b) Bun's terminal API is hard to
 * mock without re-implementing it. Tests are fast (a shell starts in a
 * few ms) and only run on POSIX — we skip on win32 because /bin/sh
 * isn't there and the existing CI matrix is POSIX-only.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { PtySession } from '../pty-session'

const SKIP = process.platform === 'win32'

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
  if (process.platform === 'win32') {
    test.skip('skipped on win32', () => {})
    return
  }

  let session: PtySession

  beforeEach(async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-getter-test-'))
    session = new PtySession({ cmd: ['/bin/sh', '-i'], cwd: dir, cols: 80, rows: 24 })
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
  if (process.platform === 'win32') {
    test.skip('skipped on win32', () => {})
    return
  }

  test('onData throwing listener is swallowed — other listeners still fire', async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync, rmSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-catch-test-'))
    const session = new PtySession({ cmd: ['/bin/sh', '-i'], cwd: dir, cols: 80, rows: 24 })
    try {
      let goodFired = false
      const unsub1 = session.onData(() => { throw new Error('listener boom') })
      const unsub2 = session.onData(() => { goodFired = true })
      session.write('echo hello\n')
      await new Promise((r) => setTimeout(r, 500))
      expect(goodFired).toBe(true)
      unsub1()
      unsub2()
    } finally {
      session.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('onExit throwing listener is swallowed — other listeners still fire', async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync, rmSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-exit-catch-test-'))
    const session = new PtySession({ cmd: ['/bin/sh', '-i'], cwd: dir, cols: 80, rows: 24 })
    try {
      let goodFired = false
      session.onExit(() => { throw new Error('exit listener boom') })
      session.onExit(() => { goodFired = true })
      session.write('exit 0\n')
      await new Promise((r) => setTimeout(r, 1000))
      expect(goodFired).toBe(true)
    } finally {
      session.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('PtySession late-onExit and unsubscribe lambdas (v3 gap-close)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on win32', () => {})
    return
  }

  test('onExit called after exit fires callback via queueMicrotask and returns no-op unsub', async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync, rmSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-late-exit-test-'))
    const session = new PtySession({ cmd: ['/bin/sh', '-i'], cwd: dir, cols: 80, rows: 24 })
    try {
      // Wait for exit first
      await new Promise<void>((resolve) => {
        session.onExit(() => resolve())
        session.write('exit 0\n')
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
      session.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('onExit unsubscribe called before exit removes the listener', async () => {
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdtempSync, rmSync } = await import('fs')
    const dir = mkdtempSync(join(tmpdir(), 'pty-unsub-exit-test-'))
    const session = new PtySession({ cmd: ['/bin/sh', '-i'], cwd: dir, cols: 80, rows: 24 })
    try {
      let fired = false
      const unsub = session.onExit(() => { fired = true })
      // Unsubscribe BEFORE exit — covers the delete lambda at line 240
      unsub()
      await new Promise<void>((resolve) => {
        session.onExit(() => resolve())
        session.write('exit 0\n')
      })
      await new Promise((r) => setTimeout(r, 50))
      // The unsubscribed listener should NOT have fired
      expect(fired).toBe(false)
    } finally {
      session.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
