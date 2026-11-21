// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Run a shell command inside a booted guest through its terminal PTY.
 *
 * Extracted verbatim from `e2e-workspace-drive.ts` (SHO-445) so the density
 * soak can drive guest workloads without a second copy of the PTY framing.
 * The behaviour is unchanged: one PTY session per command, a nonce marker to
 * find the exit status, `stty -echo` so our own command line never appears in
 * the output we parse.
 *
 * Frames: client DATA = 0x01 + bytes; server DATA = 0x81 + 4-byte seq + bytes
 * (packages/pty-core/src/pty-protocol.ts).
 */

/** The guest's pool-mode runtime token. `e2e` is what the harnesses assign with. */
export const GUEST_AUTH = { 'x-runtime-token': 'e2e' } as const

export interface GuestExecResult {
  out: string
  code: number
}

export interface GuestExecOptions {
  /** Override the runtime token (defaults to `GUEST_AUTH`). */
  token?: string
}

export async function guestExec(
  url: string,
  cmd: string,
  timeoutMs = 120_000,
  opts: GuestExecOptions = {},
): Promise<GuestExecResult> {
  const auth = { 'x-runtime-token': opts.token ?? GUEST_AUTH['x-runtime-token'] }
  const created = await fetch(`${url}/terminal/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ cols: 200, rows: 50 }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!created.ok) throw new Error(`PTY create failed (${created.status}): ${await created.text()}`)
  const { id } = (await created.json()) as { id: string }
  const nonce = Math.random().toString(36).slice(2, 10)
  const endRe = new RegExp(`__END_${nonce}_(\\d+)__`)
  let buf = ''
  try {
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/terminal/sessions/${id}/ws`, { headers: auth } as unknown as string[])
      ws.binaryType = 'arraybuffer'
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`guest command timed out after ${timeoutMs}ms: ${cmd}\n${buf.slice(-2000)}`))
      }, timeoutMs)
      ws.onopen = () => {
        // stty -echo keeps our own command line (which contains the marker) out
        // of the output we parse.
        const line = `stty -echo; { ${cmd} ; } 2>&1; echo "__END_${nonce}_$?__"\r`
        const bytes = new TextEncoder().encode(line)
        const frame = new Uint8Array(1 + bytes.length)
        frame[0] = 0x01
        frame.set(bytes, 1)
        ws.send(frame)
      }
      ws.onmessage = (ev) => {
        const data = new Uint8Array(ev.data as ArrayBuffer)
        if (data[0] !== 0x81 || data.length < 5) return
        buf += new TextDecoder().decode(data.subarray(5))
        const m = endRe.exec(buf)
        if (!m) return
        clearTimeout(timer)
        ws.close()
        const start = buf.lastIndexOf('stty -echo;')
        const body = buf.slice(0, m.index)
        const out = (start >= 0 ? body.slice(body.indexOf('\n', start) + 1) : body)
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/\r/g, '')
          .trim()
        resolve({ out, code: parseInt(m[1], 10) })
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`PTY websocket error running: ${cmd}`))
      }
    })
  } finally {
    await fetch(`${url}/terminal/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: auth }).catch(() => {})
  }
}
