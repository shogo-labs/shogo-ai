// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop Logs Routes (Shogo Desktop / `SHOGO_LOCAL_MODE=true` only).
 *
 * Live-tail of the Electron main process's `main.log`, used by the mobile
 * admin app's Logs page. Split out of the old (now-deleted) `routes/vm.ts`
 * — this endpoint reads the desktop's general application log and has
 * nothing to do with VM execution isolation, so it survives that removal.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import path from 'path'
import fs from 'fs'
import os from 'os'

function getDesktopLogPath(): string | null {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'Shogo', 'main.log')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'Shogo', 'logs', 'main.log')
  }
  return path.join(os.homedir(), '.config', 'shogo', 'logs', 'main.log')
}

export function localLogsRoutes() {
  const router = new Hono()

  /**
   * GET /logs - Read the desktop main.log (last N lines)
   * Query params:
   *   lines - number of lines to return (default 500, max 5000)
   */
  router.get('/logs', async (c) => {
    const logPath = getDesktopLogPath()
    if (!logPath || !fs.existsSync(logPath)) {
      return c.json({ lines: [], path: logPath, error: 'Log file not found' })
    }

    const maxLines = Math.min(
      parseInt(new URL(c.req.url).searchParams.get('lines') || '500', 10),
      5000,
    )

    try {
      const content = fs.readFileSync(logPath, 'utf-8')
      const allLines = content.split('\n')
      const tail = allLines.slice(-maxLines).filter(Boolean)
      return c.json({ lines: tail, path: logPath, total: allLines.length })
    } catch (err: any) {
      return c.json({ lines: [], path: logPath, error: err.message }, 500)
    }
  })

  /**
   * GET /logs/stream - SSE stream that tails main.log in real time
   */
  router.get('/logs/stream', async (c) => {
    const logPath = getDesktopLogPath()
    if (!logPath || !fs.existsSync(logPath)) {
      return c.json({ error: 'Log file not found' }, 404)
    }

    return streamSSE(c, async (stream) => {
      let lastSize = fs.statSync(logPath).size
      let alive = true

      stream.onAbort(() => { alive = false })

      while (alive) {
        try {
          const stat = fs.statSync(logPath)
          if (stat.size > lastSize) {
            const fd = fs.openSync(logPath, 'r')
            const buf = Buffer.alloc(stat.size - lastSize)
            fs.readSync(fd, buf, 0, buf.length, lastSize)
            fs.closeSync(fd)
            lastSize = stat.size

            const newLines = buf.toString('utf-8').split('\n').filter(Boolean)
            for (const line of newLines) {
              await stream.writeSSE({ data: line })
            }
          } else if (stat.size < lastSize) {
            lastSize = 0
          }
        } catch {
          break
        }
        await stream.sleep(1000)
      }
    })
  })

  return router
}
