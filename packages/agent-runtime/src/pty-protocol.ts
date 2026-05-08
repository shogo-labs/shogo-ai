// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Wire protocol between the IDE terminal client and the PTY session WebSocket.
 *
 * Binary framing: 1-byte type tag + payload. Cheaper than JSON envelopes,
 * tolerant of arbitrary bytes (PTY output may not be valid UTF-8 mid-chunk),
 * and trivial to parse on either side.
 *
 *   client → server (`ClientFrameType`):
 *     0x01 DATA    payload: raw keystroke bytes (any length, including 0)
 *     0x02 RESIZE  payload: u16 cols (BE) + u16 rows (BE)
 *     0x03 SIGNAL  payload: ASCII signal name ("INT" | "TERM" | "KILL")
 *
 *   server → client (`ServerFrameType`):
 *     0x81 DATA    payload: u32 seq (BE) + raw PTY output bytes
 *     0x82 EXIT    payload: JSON {"code":number|null,"signal":string|null}
 *     0x83 TRUNC   payload: empty - scrollback was truncated on replay
 *
 * Seq numbers are monotonic per-session, assigned by the server. The client
 * remembers the last seq it saw and reconnects with `?since=N` so the server
 * can replay missed bytes from its scrollback ring.
 */

export const ClientFrameType = {
  DATA: 0x01,
  RESIZE: 0x02,
  SIGNAL: 0x03,
} as const
export type ClientFrameTypeValue = (typeof ClientFrameType)[keyof typeof ClientFrameType]

export const ServerFrameType = {
  DATA: 0x81,
  EXIT: 0x82,
  TRUNC: 0x83,
} as const
export type ServerFrameTypeValue = (typeof ServerFrameType)[keyof typeof ServerFrameType]

export type ClientFrame =
  | { type: typeof ClientFrameType.DATA; bytes: Uint8Array }
  | { type: typeof ClientFrameType.RESIZE; cols: number; rows: number }
  | { type: typeof ClientFrameType.SIGNAL; signal: 'INT' | 'TERM' | 'KILL' }

export type ServerFrame =
  | { type: typeof ServerFrameType.DATA; seq: number; bytes: Uint8Array }
  | { type: typeof ServerFrameType.EXIT; code: number | null; signal: string | null }
  | { type: typeof ServerFrameType.TRUNC }

const ALLOWED_SIGNALS = new Set(['INT', 'TERM', 'KILL'])

// ─── encoders (server-side mostly produces server frames; client-side
//     produces client frames; we expose both for symmetry + tests) ────

export function encodeClientData(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + bytes.byteLength)
  out[0] = ClientFrameType.DATA
  out.set(bytes, 1)
  return out
}

export function encodeClientResize(cols: number, rows: number): Uint8Array {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new TypeError('cols and rows must be integers')
  }
  if (cols < 0 || cols > 0xffff || rows < 0 || rows > 0xffff) {
    throw new RangeError('cols/rows out of u16 range')
  }
  const out = new Uint8Array(5)
  out[0] = ClientFrameType.RESIZE
  // big-endian u16 pair
  out[1] = (cols >>> 8) & 0xff
  out[2] = cols & 0xff
  out[3] = (rows >>> 8) & 0xff
  out[4] = rows & 0xff
  return out
}

export function encodeClientSignal(signal: 'INT' | 'TERM' | 'KILL'): Uint8Array {
  if (!ALLOWED_SIGNALS.has(signal)) {
    throw new RangeError(`unsupported signal: ${signal}`)
  }
  const enc = new TextEncoder().encode(signal)
  const out = new Uint8Array(1 + enc.byteLength)
  out[0] = ClientFrameType.SIGNAL
  out.set(enc, 1)
  return out
}

export function encodeServerData(seq: number, bytes: Uint8Array): Uint8Array {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new RangeError('seq out of u32 range')
  }
  const out = new Uint8Array(5 + bytes.byteLength)
  out[0] = ServerFrameType.DATA
  out[1] = (seq >>> 24) & 0xff
  out[2] = (seq >>> 16) & 0xff
  out[3] = (seq >>> 8) & 0xff
  out[4] = seq & 0xff
  out.set(bytes, 5)
  return out
}

export function encodeServerExit(code: number | null, signal: string | null): Uint8Array {
  const json = JSON.stringify({ code, signal })
  const enc = new TextEncoder().encode(json)
  const out = new Uint8Array(1 + enc.byteLength)
  out[0] = ServerFrameType.EXIT
  out.set(enc, 1)
  return out
}

export function encodeServerTrunc(): Uint8Array {
  return new Uint8Array([ServerFrameType.TRUNC])
}

// ─── decoders ────────────────────────────────────────────────────────

/**
 * Decode a client→server frame. Returns null for malformed input rather than
 * throwing — the WS handler should drop bad frames (and probably the
 * connection), not crash the manager.
 */
export function decodeClientFrame(buf: Uint8Array): ClientFrame | null {
  if (buf.byteLength < 1) return null
  const type = buf[0]
  const payload = buf.subarray(1)
  switch (type) {
    case ClientFrameType.DATA:
      // Zero-length data is valid (no-op write); preserved for symmetry.
      return { type: ClientFrameType.DATA, bytes: payload }
    case ClientFrameType.RESIZE: {
      if (payload.byteLength !== 4) return null
      const cols = (payload[0] << 8) | payload[1]
      const rows = (payload[2] << 8) | payload[3]
      return { type: ClientFrameType.RESIZE, cols, rows }
    }
    case ClientFrameType.SIGNAL: {
      const sig = new TextDecoder().decode(payload)
      if (sig !== 'INT' && sig !== 'TERM' && sig !== 'KILL') return null
      return { type: ClientFrameType.SIGNAL, signal: sig }
    }
    default:
      return null
  }
}

export function decodeServerFrame(buf: Uint8Array): ServerFrame | null {
  if (buf.byteLength < 1) return null
  const type = buf[0]
  const payload = buf.subarray(1)
  switch (type) {
    case ServerFrameType.DATA: {
      if (payload.byteLength < 4) return null
      const seq =
        ((payload[0] << 24) >>> 0) +
        ((payload[1] << 16) >>> 0) +
        ((payload[2] << 8) >>> 0) +
        (payload[3] >>> 0)
      return { type: ServerFrameType.DATA, seq, bytes: payload.subarray(4) }
    }
    case ServerFrameType.EXIT: {
      try {
        const json = new TextDecoder().decode(payload)
        const obj = JSON.parse(json) as { code?: unknown; signal?: unknown }
        const code = typeof obj.code === 'number' ? obj.code : null
        const signal = typeof obj.signal === 'string' ? obj.signal : null
        return { type: ServerFrameType.EXIT, code, signal }
      } catch {
        return null
      }
    }
    case ServerFrameType.TRUNC:
      return { type: ServerFrameType.TRUNC }
    default:
      return null
  }
}
