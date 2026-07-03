// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Console → OpenTelemetry logs bridge.
 *
 * The API emits the vast majority of its operational logs through plain
 * `console.*` calls (~200 call sites). Rather than rewrite all of them, this
 * bridge patches the console methods so every call ALSO emits an OTLP log
 * record via the global `LoggerProvider` configured in `instrumentation.ts`.
 *
 * Design constraints:
 * - stdout is preserved: the original console method is always invoked first,
 *   so container-log scraping (SigNoz k8s-infra) and local dev output are
 *   unaffected.
 * - trace correlation: the Logs SDK captures the active span context at
 *   `emit()` time, so records carry `trace_id`/`span_id` and line up with the
 *   request spans created by the tracing middleware.
 * - non-recursive: a re-entrancy guard prevents the exporter's own failure
 *   logging (which goes through `console.error`) from looping back into the
 *   bridge.
 * - best-effort: any error while emitting a record is swallowed — telemetry
 *   must never break the request path.
 */

import { format } from 'node:util'
import { logs, SeverityNumber, type Logger } from '@opentelemetry/api-logs'

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'

const SEVERITY: Record<ConsoleMethod, { number: SeverityNumber; text: string }> = {
  debug: { number: SeverityNumber.DEBUG, text: 'DEBUG' },
  log: { number: SeverityNumber.INFO, text: 'INFO' },
  info: { number: SeverityNumber.INFO, text: 'INFO' },
  warn: { number: SeverityNumber.WARN, text: 'WARN' },
  error: { number: SeverityNumber.ERROR, text: 'ERROR' },
}

let installed = false
// Guards against re-entrancy: while we're emitting a record, any console call
// made by the OTEL SDK (e.g. exporter errors) must not re-enter the bridge.
let emitting = false

/**
 * Patch `console.*` so each call also emits an OTLP log record.
 * Idempotent and gated by the `OTEL_LOGS_CONSOLE_BRIDGE` env var
 * (set to "false" to disable). Returns true if the bridge was installed.
 */
export function installConsoleBridge(loggerName = 'shogo-api'): boolean {
  if (installed) return true
  if (process.env.OTEL_LOGS_CONSOLE_BRIDGE === 'false') {
    console.log('[OTEL] Console→logs bridge disabled (OTEL_LOGS_CONSOLE_BRIDGE=false)')
    return false
  }

  const logger: Logger = logs.getLogger(loggerName)
  const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug']

  for (const method of methods) {
    const original = console[method]?.bind(console) ?? console.log.bind(console)

    console[method] = (...args: unknown[]): void => {
      // Always preserve stdout/stderr first.
      original(...args)

      if (emitting) return
      emitting = true
      try {
        const severity = SEVERITY[method]
        logger.emit({
          severityNumber: severity.number,
          severityText: severity.text,
          body: format(...(args as [unknown, ...unknown[]])),
        })
      } catch {
        // best-effort: never let telemetry break logging
      } finally {
        emitting = false
      }
    }
  }

  installed = true
  console.log('[OTEL] Console→logs bridge installed')
  return true
}
