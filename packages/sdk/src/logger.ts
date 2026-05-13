// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Structured logger for Shogo runtime services.
 *
 * Outputs JSON lines in production / staging (suitable for SigNoz log
 * collection or any structured log pipeline) and a human-readable
 * `[service] msg {extra}` format in development.
 *
 * Lifted into the SDK from `@shogo/shared-runtime` (was AGPL) under MIT
 * so userland agent/app code can import the same logger the runtime
 * services use without dragging an AGPL workspace dependency.
 *
 * @example
 *   import { createLogger } from '@shogo-ai/sdk/logger'
 *
 *   const log = createLogger('my-service')
 *   log.info('boot complete', { port: 8002 })
 *
 *   const reqLog = log.child({ requestId: 'r-123' })
 *   reqLog.warn('slow query', { ms: 4200 })
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  level: LogLevel
  msg: string
  service: string
  timestamp: string
  [key: string]: unknown
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
const minLevel = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || 'info'] ?? 1

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= minLevel
}

function formatEntry(entry: LogEntry): string {
  if (isProduction) {
    return JSON.stringify(entry)
  }
  const { level: _level, msg, service, timestamp: _timestamp, ...extra } = entry
  const extraStr = Object.keys(extra).length > 0
    ? ' ' + JSON.stringify(extra)
    : ''
  return `[${service}] ${msg}${extraStr}`
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
  /** Returns a new logger that merges `extra` into every log entry. */
  child(extra: Record<string, unknown>): Logger
}

export function createLogger(service: string, defaultExtra?: Record<string, unknown>): Logger {
  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (!shouldLog(level)) return

    const entry: LogEntry = {
      level,
      msg,
      service,
      timestamp: new Date().toISOString(),
      ...defaultExtra,
      ...extra,
    }

    const formatted = formatEntry(entry)

    switch (level) {
      case 'error':
        console.error(formatted)
        break
      case 'warn':
        console.warn(formatted)
        break
      default:
        console.log(formatted)
        break
    }
  }

  return {
    debug: (msg, extra) => log('debug', msg, extra),
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    child: (extra) => createLogger(service, { ...defaultExtra, ...extra }),
  }
}
