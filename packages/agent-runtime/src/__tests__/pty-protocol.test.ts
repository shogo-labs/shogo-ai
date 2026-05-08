// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  ClientFrameType,
  ServerFrameType,
  decodeClientFrame,
  decodeServerFrame,
  encodeClientData,
  encodeClientResize,
  encodeClientSignal,
  encodeServerData,
  encodeServerExit,
  encodeServerTrunc,
} from '../pty-protocol'

function bytes(...n: number[]): Uint8Array {
  return new Uint8Array(n)
}

describe('pty-protocol — client frames', () => {
  test('DATA round-trips a non-empty payload', () => {
    const payload = bytes(0x68, 0x69) // "hi"
    const frame = encodeClientData(payload)
    expect(frame[0]).toBe(ClientFrameType.DATA)
    const decoded = decodeClientFrame(frame)
    expect(decoded?.type).toBe(ClientFrameType.DATA)
    if (decoded?.type !== ClientFrameType.DATA) throw new Error('unreachable')
    expect(Array.from(decoded.bytes)).toEqual([0x68, 0x69])
  })

  test('DATA accepts zero-length payload', () => {
    const decoded = decodeClientFrame(encodeClientData(bytes()))
    expect(decoded?.type).toBe(ClientFrameType.DATA)
  })

  test('RESIZE round-trips cols/rows as big-endian u16', () => {
    const frame = encodeClientResize(180, 50)
    // 0x02 type + 0x00B4 (180) + 0x0032 (50)
    expect(Array.from(frame)).toEqual([0x02, 0x00, 0xb4, 0x00, 0x32])
    const decoded = decodeClientFrame(frame)
    expect(decoded).toEqual({ type: ClientFrameType.RESIZE, cols: 180, rows: 50 })
  })

  test('RESIZE rejects non-integers and out-of-range', () => {
    expect(() => encodeClientResize(80.5, 24)).toThrow(TypeError)
    expect(() => encodeClientResize(-1, 24)).toThrow(RangeError)
    expect(() => encodeClientResize(80, 70000)).toThrow(RangeError)
  })

  test('RESIZE decode rejects wrong payload length', () => {
    expect(decodeClientFrame(bytes(0x02, 0x00, 0x50))).toBeNull()
    expect(decodeClientFrame(bytes(0x02, 0x00, 0x50, 0x00, 0x18, 0x00))).toBeNull()
  })

  test('SIGNAL round-trips known signals', () => {
    for (const sig of ['INT', 'TERM', 'KILL'] as const) {
      const frame = encodeClientSignal(sig)
      const decoded = decodeClientFrame(frame)
      expect(decoded).toEqual({ type: ClientFrameType.SIGNAL, signal: sig })
    }
  })

  test('SIGNAL rejects unknown signal strings on decode', () => {
    const frame = new Uint8Array([0x03, 0x48, 0x55, 0x50]) // "HUP"
    expect(decodeClientFrame(frame)).toBeNull()
  })

  test('SIGNAL encode rejects unknown signal', () => {
    expect(() => encodeClientSignal('HUP' as unknown as 'INT')).toThrow(RangeError)
  })

  test('decode returns null for empty buffer or unknown type', () => {
    expect(decodeClientFrame(bytes())).toBeNull()
    expect(decodeClientFrame(bytes(0xff))).toBeNull()
  })
})

describe('pty-protocol — server frames', () => {
  test('DATA encodes seq as big-endian u32 and round-trips', () => {
    const payload = bytes(0xde, 0xad, 0xbe, 0xef)
    const frame = encodeServerData(0x01020304, payload)
    expect(Array.from(frame.subarray(0, 5))).toEqual([0x81, 0x01, 0x02, 0x03, 0x04])
    const decoded = decodeServerFrame(frame)
    expect(decoded?.type).toBe(ServerFrameType.DATA)
    if (decoded?.type !== ServerFrameType.DATA) throw new Error('unreachable')
    expect(decoded.seq).toBe(0x01020304)
    expect(Array.from(decoded.bytes)).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  test('DATA handles seq up to u32 max', () => {
    const decoded = decodeServerFrame(encodeServerData(0xffffffff, bytes(0x01)))
    expect(decoded?.type).toBe(ServerFrameType.DATA)
    if (decoded?.type !== ServerFrameType.DATA) throw new Error('unreachable')
    expect(decoded.seq).toBe(0xffffffff)
  })

  test('DATA encode rejects out-of-range seq', () => {
    expect(() => encodeServerData(-1, bytes())).toThrow(RangeError)
    expect(() => encodeServerData(0x100000000, bytes())).toThrow(RangeError)
  })

  test('DATA decode rejects truncated header', () => {
    expect(decodeServerFrame(bytes(0x81, 0x00, 0x00, 0x00))).toBeNull()
  })

  test('EXIT round-trips both code and signal', () => {
    const decoded = decodeServerFrame(encodeServerExit(137, 'SIGKILL'))
    expect(decoded).toEqual({
      type: ServerFrameType.EXIT,
      code: 137,
      signal: 'SIGKILL',
    })
  })

  test('EXIT round-trips null fields', () => {
    const decoded = decodeServerFrame(encodeServerExit(null, null))
    expect(decoded).toEqual({ type: ServerFrameType.EXIT, code: null, signal: null })
  })

  test('EXIT decode returns null for malformed JSON', () => {
    const enc = new TextEncoder().encode('not-json')
    const buf = new Uint8Array(1 + enc.byteLength)
    buf[0] = ServerFrameType.EXIT
    buf.set(enc, 1)
    expect(decodeServerFrame(buf)).toBeNull()
  })

  test('TRUNC is a single-byte sentinel', () => {
    const frame = encodeServerTrunc()
    expect(Array.from(frame)).toEqual([0x83])
    expect(decodeServerFrame(frame)).toEqual({ type: ServerFrameType.TRUNC })
  })

  test('decode returns null for unknown server type', () => {
    expect(decodeServerFrame(bytes(0xfe))).toBeNull()
  })
})
