// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, type Page } from "./fixtures"
import { bootstrapApiBase } from "./helpers"

/**
 * Run `cmd` in the project's runtime through a terminal PTY session and return
 * its output and exit status. Frames: client DATA = 0x01 + bytes; server DATA =
 * 0x81 + 4-byte seq + bytes (packages/pty-core/src/pty-protocol.ts).
 */
export async function runtimeExec(
  page: Page,
  projectId: string,
  cmd: string,
  timeoutMs = 180_000,
): Promise<{ out: string; code: number }> {
  const base = bootstrapApiBase()
  const deadline = Date.now() + 240_000
  let session: { id: string } | null = null
  // The runtime may still be waking right after an open; retry the create.
  while (!session) {
    const res = await page.request
      .post(`${base}/api/projects/${projectId}/terminal/sessions`, {
        headers: { Origin: base, "content-type": "application/json" },
        data: { cols: 200, rows: 50 },
        timeout: 120_000,
      })
      .catch(() => null)
    if (res?.ok()) session = (await res.json()) as { id: string }
    else if (Date.now() > deadline) {
      throw new Error(`terminal session create failed (${res?.status() ?? "timeout"}): ${(await res?.text()) ?? ""}`)
    } else await page.waitForTimeout(3_000)
  }
  try {
    const wsUrl = `${base.replace(/^http/, "ws")}/api/projects/${projectId}/terminal/sessions/${session.id}/ws`
    return await page.evaluate(
      ({ wsUrl, cmd, timeoutMs }) =>
        new Promise<{ out: string; code: number }>((resolve, reject) => {
          const nonce = Math.random().toString(36).slice(2, 10)
          const endRe = new RegExp(`__END_${nonce}_(\\d+)__`)
          let buf = ""
          const ws = new WebSocket(wsUrl)
          ws.binaryType = "arraybuffer"
          const timer = setTimeout(() => {
            ws.close()
            reject(new Error(`runtime command timed out: ${cmd}\n${buf.slice(-2000)}`))
          }, timeoutMs)
          ws.onopen = () => {
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
            const start = buf.lastIndexOf("stty -echo;")
            const body = buf.slice(0, m.index)
            const out = (start >= 0 ? body.slice(body.indexOf("\n", start) + 1) : body).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").trim()
            resolve({ out, code: parseInt(m[1], 10) })
          }
          ws.onerror = () => {
            clearTimeout(timer)
            reject(new Error(`terminal websocket error running: ${cmd}`))
          }
        }),
      { wsUrl, cmd, timeoutMs },
    )
  } finally {
    await page.request
      .delete(`${base}/api/projects/${projectId}/terminal/sessions/${session.id}`, { headers: { Origin: base } })
      .catch(() => {})
  }
}

export async function mustExec(page: Page, projectId: string, cmd: string, timeoutMs?: number): Promise<string> {
  const r = await runtimeExec(page, projectId, cmd, timeoutMs)
  expect(r.code, `\`${cmd}\` failed:\n${r.out}`).toBe(0)
  return r.out
}
