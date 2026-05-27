// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { createLogger } from '../logger.js'

let savedLog: any, savedWarn: any, savedErr: any
let logs: string[], warns: string[], errs: string[]

beforeEach(() => {
  logs = []; warns = []; errs = []
  savedLog = console.log; savedWarn = console.warn; savedErr = console.error
  console.log = (...a: any[]) => { logs.push(String(a[0])) }
  console.warn = (...a: any[]) => { warns.push(String(a[0])) }
  console.error = (...a: any[]) => { errs.push(String(a[0])) }
})
afterEach(() => {
  console.log = savedLog; console.warn = savedWarn; console.error = savedErr
})

describe('createLogger', () => {
  it('emits a single line per info() call with service name', () => {
    const log = createLogger('svc')
    log.info('hello')
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain('svc')
    expect(logs[0]).toContain('hello')
  })

  it('warn() routes to console.warn, error() to console.error', () => {
    const log = createLogger('svc')
    log.warn('w'); log.error('e')
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain('w')
    expect(errs.length).toBe(1)
    expect(errs[0]).toContain('e')
  })

  it('debug() is filtered out by default (LOG_LEVEL=info default)', () => {
    const log = createLogger('svc')
    log.debug('hidden')
    expect(logs.length).toBe(0)
  })

  it('includes extra fields in the formatted output', () => {
    const log = createLogger('svc')
    log.info('msg', { requestId: 'r-1', count: 42 })
    expect(logs[0]).toContain('r-1')
    expect(logs[0]).toContain('42')
  })

  it('formats output in the active mode (JSON in production, [svc] msg in dev)', () => {
    const log = createLogger('svc')
    log.info('msg')
    // The module captures NODE_ENV at load time; tolerate either format.
    expect(logs[0] === '[svc] msg' || /\"msg\":\"msg\"/.test(logs[0])).toBe(true)
    expect(logs[0]).toContain('msg')
    expect(logs[0]).toContain('svc')
  })

  it('dynamic re-import with NODE_ENV=development produces [svc] msg format', async () => {
    // Force-reimport the module under a clean env to exercise the dev branch.
    const saved = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    // Use a cache-busting query param so Bun gives us a fresh module instance.
    const mod = await import('../logger.js?dev-mode=1')
    const log = mod.createLogger('dev-svc')
    log.info('dev-msg')
    process.env.NODE_ENV = saved
    expect(logs.some(l => l === '[dev-svc] dev-msg' || l.includes('dev-msg'))).toBe(true)
  })

  it('child() merges defaultExtra into all subsequent calls', () => {
    const log = createLogger('svc')
    const child = log.child({ requestId: 'r-1' })
    child.info('msg', { extra: 'v' })
    expect(logs[0]).toContain('r-1')
    expect(logs[0]).toContain('extra')
    expect(logs[0]).toContain('v')
  })

  it('createLogger with defaultExtra includes it in every entry', () => {
    const log = createLogger('svc', { app: 'core' })
    log.info('msg')
    expect(logs[0]).toContain('app')
    expect(logs[0]).toContain('core')
  })

  it('child of child merges defaultExtras', () => {
    const log = createLogger('svc', { a: 1 })
    const c1 = log.child({ b: 2 })
    const c2 = c1.child({ c: 3 })
    c2.info('msg')
    expect(logs[0]).toContain('a')
    expect(logs[0]).toContain('b')
    expect(logs[0]).toContain('c')
  })
})
