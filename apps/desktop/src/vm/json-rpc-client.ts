// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ChildProcess } from 'child_process'

interface PendingRequest {
  resolve: (result: any) => void
  reject: (error: Error) => void
}

/**
 * JSON-RPC client over stdin/stdout of a child process.
 * Used to communicate with the Go VM helper on macOS.
 */
export class JsonRpcClient {
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private buffer = ''

  constructor(private process: ChildProcess) {
    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString()
      this.processBuffer()
    })

    this.process.on('exit', () => {
      for (const [, req] of this.pending) {
        req.reject(new Error('Go helper process exited'))
      }
      this.pending.clear()
    })
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const response = JSON.parse(line)
        const pending = this.pending.get(response.id)
        if (pending) {
          this.pending.delete(response.id)
          if (response.error) {
            pending.reject(new Error(response.error))
          } else {
            pending.resolve(response.result)
          }
        }
      } catch {
        // ignore malformed lines (could be Go helper stderr leak)
      }
    }
  }

  async call<T>(method: string, params?: any): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })

      const request = JSON.stringify({ id, method, params })
      const ok = this.process.stdin?.write(request + '\n')
      if (!ok) {
        this.pending.delete(id)
        reject(new Error('Failed to write to Go helper stdin'))
      }
    })
  }

  destroy(): void {
    for (const [, req] of this.pending) {
      req.reject(new Error('Client destroyed'))
    }
    this.pending.clear()
  }
}
