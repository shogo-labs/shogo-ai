// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client-side mirror of the runtime's PTY WS protocol. Kept as a duplicate
 * (rather than a shared package) because the runtime package isn't import-
 * able from the mobile app (Expo bundler can't follow into Bun-only deps),
 * and the protocol is small + stable enough that drift is unlikely.
 *
 * Keep in sync with:
 *   packages/agent-runtime/src/pty-protocol.ts
 *
 * Frame layout — 1-byte type + payload:
 *   client → server (`ClientFrameType`):
 *     0x01 DATA    raw keystrokes
 *     0x02 RESIZE  u16 cols (BE) + u16 rows (BE)
 *     0x03 SIGNAL  ASCII signal name ("INT" | "TERM" | "KILL")
 *
 *   server → client (`ServerFrameType`):
 *     0x81 DATA    u32 seq (BE) + raw PTY output bytes
 *     0x82 EXIT    JSON {"code":number|null,"signal":string|null}
 *     0x83 TRUNC   empty — scrollback was truncated on replay
 */

export const ClientFrameType = {
  DATA: 0x01,
  RESIZE: 0x02,
  SIGNAL: 0x03,
} as const

export const ServerFrameType = {
  DATA: 0x81,
  EXIT: 0x82,
  TRUNC: 0x83,
} as const

export type ServerFrame =
  | { type: typeof ServerFrameType.DATA; seq: number; bytes: Uint8Array }
  | { type: typeof ServerFrameType.EXIT; code: number | null; signal: string | null }
  | { type: typeof ServerFrameType.TRUNC }

export function encodeClientData(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + bytes.byteLength)
  out[0] = ClientFrameType.DATA
  out.set(bytes, 1)
  return out
}

export function encodeClientResize(cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(5)
  out[0] = ClientFrameType.RESIZE
  out[1] = (cols >>> 8) & 0xff
  out[2] = cols & 0xff
  out[3] = (rows >>> 8) & 0xff
  out[4] = rows & 0xff
  return out
}

export function encodeClientSignal(signal: 'INT' | 'TERM' | 'KILL'): Uint8Array {
  const enc = new TextEncoder().encode(signal)
  const out = new Uint8Array(1 + enc.byteLength)
  out[0] = ClientFrameType.SIGNAL
  out.set(enc, 1)
  return out
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
        const obj = JSON.parse(new TextDecoder().decode(payload)) as {
          code?: unknown; signal?: unknown
        }
        return {
          type: ServerFrameType.EXIT,
          code: typeof obj.code === 'number' ? obj.code : null,
          signal: typeof obj.signal === 'string' ? obj.signal : null,
        }
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
