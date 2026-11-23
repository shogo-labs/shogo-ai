// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-482: `migrate deploy` was killed at 30 s on a cold `bun x prisma` start,
 * and `main.log` kept only the FATAL line — none of the output that said why.
 *
 * These pin the three things that fixes: the budget is long enough for a cold
 * start, a timeout is retried once, and a failure writes code/signal/elapsed
 * plus the full stdout and stderr to `main.log`, synchronously, before the throw
 * that ends the boot.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  MIGRATE_DEPLOY_TIMEOUT_MS,
  describeMigrateFailure,
  isTimeout,
  runMigrateDeploy,
} from '../migrate-deploy'
import { appendMainLogLineSync, formatLogLine } from '../main-log'

const migrated = 'All migrations have been successfully applied.'

function timeoutError(): Error & { signal?: string; code?: string } {
  const err: Error & { signal?: string; code?: string; stdout?: string; stderr?: string } = new Error(
    'Command failed: prisma migrate deploy',
  )
  err.signal = 'SIGTERM'
  err.stdout = ''
  err.stderr = ''
  return err
}

describe('the migrate deploy timeout', () => {
  test('is long enough for a cold prisma start', () => {
    // The observed cold starts were 1.2 s, 28 s and over 30 s.
    expect(MIGRATE_DEPLOY_TIMEOUT_MS).toBe(120_000)
  })

  test('the attempt is given the full budget', () => {
    const budgets: number[] = []
    runMigrateDeploy('prisma migrate deploy', {
      run: (_command, timeoutMs) => {
        budgets.push(timeoutMs)
        return migrated
      },
    })
    expect(budgets).toEqual([MIGRATE_DEPLOY_TIMEOUT_MS])
  })
})

describe('runMigrateDeploy()', () => {
  test('retries once when the first attempt was killed at the timeout', () => {
    const calls: number[] = []
    const attempt = runMigrateDeploy('prisma migrate deploy', {
      run: () => {
        calls.push(calls.length + 1)
        if (calls.length === 1) throw timeoutError()
        return migrated
      },
    })

    expect(calls).toHaveLength(2)
    expect(attempt.ok).toBe(true)
    expect(attempt.number).toBe(2)
    expect(attempt.stdout).toBe(migrated)
  })

  test('does not retry a failure that is not a timeout', () => {
    let calls = 0
    const err: any = new Error('P3005: database schema is not empty')
    err.code = 1
    err.stdout = ''
    err.stderr = 'P3005: database schema is not empty'

    const attempt = runMigrateDeploy('prisma migrate deploy', {
      run: () => {
        calls++
        throw err
      },
    })

    expect(calls).toBe(1)
    expect(attempt.ok).toBe(false)
    expect(attempt.timedOut).toBe(false)
    expect(attempt.stderr).toContain('P3005')
  })

  test('reports a second timeout as a failed attempt, not another retry', () => {
    let calls = 0
    const attempt = runMigrateDeploy('prisma migrate deploy', {
      run: () => {
        calls++
        throw timeoutError()
      },
    })

    expect(calls).toBe(2)
    expect(attempt.ok).toBe(false)
    expect(attempt.timedOut).toBe(true)
    expect(attempt.number).toBe(2)
  })

  test('treats ETIMEDOUT and a killed-by-signal exit as timeouts', () => {
    expect(isTimeout({ code: 'ETIMEDOUT' }, 1_000, 120_000)).toBe(true)
    expect(isTimeout({ signal: 'SIGTERM' }, 1_000, 120_000)).toBe(true)
    // Bun does not always set a code: a run that spent its whole budget was
    // killed by the timeout.
    expect(isTimeout(new Error('Command failed'), 120_001, 120_000)).toBe(true)
    expect(isTimeout({ code: 1 }, 900, 120_000)).toBe(false)
  })
})

describe('what a failure leaves in main.log', () => {
  test('code, signal, elapsed and the full output — empty fields included', () => {
    const err: any = timeoutError()
    const lines = describeMigrateFailure({
      ok: false,
      stdout: '',
      stderr: 'Prisma schema loaded from prisma/schema.local.prisma',
      error: err,
      timedOut: true,
      elapsedMs: 120_004,
      number: 2,
    })

    expect(lines[0]).toContain('code=(none)')
    expect(lines[0]).toContain('signal=SIGTERM')
    expect(lines[0]).toContain('elapsed=120004ms')
    expect(lines[0]).toContain('timedOut=true')
    expect(lines[0]).toContain('attempt=2')
    expect(lines[1]).toContain('stdout: (empty)')
    expect(lines[2]).toContain('stderr: Prisma schema loaded')
  })

  test('the lines are on disk before the FATAL line that follows them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-main-log-'))
    const logFile = join(dir, 'main.log')

    const lines = describeMigrateFailure({
      ok: false,
      stdout: 'stdout went here',
      stderr: '',
      error: Object.assign(new Error('boom'), { code: 1 }),
      timedOut: false,
      elapsedMs: 1_234,
      number: 1,
    })
    for (const line of lines) appendMainLogLineSync(logFile, 'ERROR', line)
    // main.ts writes its FATAL line with the same synchronous path.
    appendMainLogLineSync(logFile, 'FATAL', '[Desktop] Failed to start local server:', new Error('x'))

    const text = readFileSync(logFile, 'utf8')
    const migrationAt = text.indexOf('migrate deploy failed:')
    expect(migrationAt).toBeGreaterThan(-1)
    expect(text.indexOf('stdout went here')).toBeGreaterThan(migrationAt)
    expect(text.indexOf('stderr: (empty)')).toBeGreaterThan(migrationAt)
    expect(text.indexOf('[FATAL]')).toBeGreaterThan(text.indexOf('stderr: (empty)'))
  })

  test('the log line format matches the shell tee', () => {
    const line = formatLogLine('ERROR', ['migrate deploy failed'], new Date('2026-11-21T03:00:00.000Z'))
    expect(line).toBe('2026-11-21T03:00:00.000Z [ERROR] migrate deploy failed\n')
  })

  test('a log that cannot be written is reported, not thrown', () => {
    expect(appendMainLogLineSync('/dev/null/not-a-dir/main.log', 'ERROR', 'x')).toBe(false)
  })
})

describe('the desktop migrator uses it', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'local-server.ts'), 'utf8')

  test('every migrate deploy goes through the shared timeout + retry', () => {
    expect(source).toContain('runMigrateDeploy(')
    // The 30 s literal that a cold start could not meet.
    expect(source).not.toContain('timeout: 30000')
    expect(source).toContain("runDeploy('prisma.config.js')")
    expect(source).toContain("runDeploy('prisma.config.local.ts')")
  })

  test('a failed deploy is written synchronously before the throw', () => {
    const fnAt = source.indexOf('function logMigrateFailure')
    expect(fnAt).toBeGreaterThan(-1)
    const body = source.slice(fnAt, source.indexOf('function runMigrations'))
    expect(body).toContain('appendMainLogLineSync')
    // Both failure paths call it before throwing.
    const calls = source.split('logMigrateFailure(attempt)').length - 1
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
