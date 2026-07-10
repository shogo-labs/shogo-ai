// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Option B: the API's stdout line must carry the active trace context so the
// SigNoz log pipeline can promote trace_id/span_id into linked trace fields —
// giving log↔trace correlation WITHOUT depending on the app's (unreliable)
// OTLP log export. `formatConsoleRecord` is the pure record builder behind the
// console patch; these lock its shape so the pipeline's parsers keep matching.
import { describe, test, expect } from 'bun:test'
import { formatConsoleRecord } from '../lib/structured-console'

const TRACE = 'a'.repeat(32)
const SPAN = 'b'.repeat(16)

describe('formatConsoleRecord', () => {
  test('emits a single-line JSON record with the standard fields', () => {
    const line = formatConsoleRecord('info', ['[MetalPool] assigned', 42], 'shogo-api', null)
    expect(line).not.toContain('\n')
    const rec = JSON.parse(line)
    expect(rec.level).toBe('info')
    expect(rec.service).toBe('shogo-api')
    // util.format joins args like console does, preserving the substring that
    // string-based alerts/dashboards match on.
    expect(rec.msg).toBe('[MetalPool] assigned 42')
    expect(typeof rec.timestamp).toBe('string')
  })

  test('stamps trace_id/span_id when a span context is active', () => {
    const rec = JSON.parse(
      formatConsoleRecord('error', ['boom'], 'shogo-api', { traceId: TRACE, spanId: SPAN }),
    )
    expect(rec.level).toBe('error')
    expect(rec.trace_id).toBe(TRACE)
    expect(rec.span_id).toBe(SPAN)
  })

  test('omits trace fields entirely when there is no active span', () => {
    const rec = JSON.parse(formatConsoleRecord('warn', ['no span here'], 'shogo-api', null))
    expect(rec).not.toHaveProperty('trace_id')
    expect(rec).not.toHaveProperty('span_id')
  })

  test('serializes object args the way console would (not "[object Object]")', () => {
    const rec = JSON.parse(
      formatConsoleRecord('info', ['ctx', { region: 'us', n: 3 }], 'shogo-api', null),
    )
    expect(rec.msg).toContain('region')
    expect(rec.msg).toContain('us')
  })
})
