// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-482: the desktop API had no process-level error handlers.
 *
 * Cloud `server.ts` logged unhandled rejections and kept running; the slim
 * local composer had none, and Bun exits on an unhandled rejection. That is how
 * one escaped dispatcher promise turned into "Shogo won't open".
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  installProcessErrorHandlers,
  resetProcessErrorHandlersForTests,
} from '../lib/process-error-handlers'

type Handler = (...args: any[]) => void

/** The handlers this call added, by diffing the listener list. */
function installAndCapture(tag: string): { rejection: Handler; exception: Handler } {
  const beforeRejection = new Set(process.listeners('unhandledRejection'))
  const beforeException = new Set(process.listeners('uncaughtException'))
  installProcessErrorHandlers(tag)
  const rejection = process.listeners('unhandledRejection').find((l) => !beforeRejection.has(l))
  const exception = process.listeners('uncaughtException').find((l) => !beforeException.has(l))
  expect(rejection).toBeDefined()
  expect(exception).toBeDefined()
  return { rejection: rejection as Handler, exception: exception as Handler }
}

function remove(handlers: { rejection: Handler; exception: Handler } | null): void {
  if (!handlers) return
  process.removeListener('unhandledRejection', handlers.rejection)
  process.removeListener('uncaughtException', handlers.exception)
}

const realError = console.error
const realWarn = console.warn
let captured: unknown[][] = []
let handlers: { rejection: Handler; exception: Handler } | null = null

afterEach(() => {
  console.error = realError
  console.warn = realWarn
  remove(handlers)
  handlers = null
  captured = []
  resetProcessErrorHandlersForTests()
})

function capture(): void {
  captured = []
  console.error = (...args: unknown[]) => {
    captured.push(args)
  }
  console.warn = (...args: unknown[]) => {
    captured.push(args)
  }
}

describe('installProcessErrorHandlers()', () => {
  test('logs an unhandled rejection instead of letting it exit', () => {
    handlers = installAndCapture('LocalAPI')
    capture()

    expect(() => handlers!.rejection(new Error('Chat proxy returned 500: timed out'))).not.toThrow()

    const line = captured.map((args) => args.join(' ')).join('\n')
    expect(line).toContain('[LocalAPI] Unhandled promise rejection:')
    expect(line).toContain('Chat proxy returned 500')
  })

  test('suppresses the timeout rejections a cold start produces by design', () => {
    handlers = installAndCapture('LocalAPI')
    capture()

    const timeout = new Error('The operation timed out.')
    timeout.name = 'TimeoutError'
    handlers!.rejection(timeout)

    expect(captured).toHaveLength(1)
    expect(String(captured[0][0])).toContain('Suppressed timeout rejection')
  })

  test('logs an uncaught exception and keeps running', () => {
    handlers = installAndCapture('LocalAPI')
    capture()

    expect(() => handlers!.exception(new Error('boom'))).not.toThrow()
    expect(String(captured[0][0])).toContain('[LocalAPI] Uncaught exception:')
    expect(String(captured[0][1])).toContain('boom')
  })

  test('installs once, whatever the tag', () => {
    handlers = installAndCapture('LocalAPI')
    const count = process.listenerCount('unhandledRejection')
    installProcessErrorHandlers('API')
    expect(process.listenerCount('unhandledRejection')).toBe(count)
  })
})

describe('both composers install the handlers', () => {
  const api = (file: string) => readFileSync(join(import.meta.dir, '..', file), 'utf8')

  test('the desktop composer installs them before it creates the app', () => {
    const source = api('local-server.ts')
    const installAt = source.indexOf('installProcessErrorHandlers(')
    expect(installAt).toBeGreaterThan(-1)
    expect(installAt).toBeLessThan(source.indexOf('createLocalApp()'))
  })

  test('the cloud composer installs them too', () => {
    expect(api('server.ts')).toContain('installProcessErrorHandlers(')
  })
})
