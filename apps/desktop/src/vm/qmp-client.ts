// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { connect, type Socket } from 'net'

interface QMPGreeting {
  QMP: { version: { qemu: { major: number; minor: number; micro: number } } }
}

interface QMPResponse {
  return?: any
  error?: { class: string; desc: string }
  event?: string
}

interface PendingCommand {
  resolve: (result: any) => void
  reject: (error: Error) => void
}

/**
 * QMP (QEMU Machine Protocol) client for Windows.
 * Communicates over a named pipe or Unix socket.
 *
 * Protocol:
 *   1. Connect -> read greeting JSON
 *   2. Send qmp_capabilities handshake
 *   3. Send commands, receive responses (JSON, one per line)
 */
export class QMPClient {
  private socket: Socket | null = null
  private buffer = ''
  private greeting: QMPGreeting | null = null
  private ready = false
  private queue: PendingCommand[] = []
  private onReady: (() => void) | null = null

  /** Accept either a pipe path (string) or TCP port number */
  constructor(private target: string | number) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = typeof this.target === 'number'
        ? connect({ host: '127.0.0.1', port: this.target })
        : connect(this.target)

      this.socket.on('error', (err) => {
        if (!this.ready) reject(err)
      })

      this.socket.on('data', (data: Buffer) => {
        this.buffer += data.toString()
        this.processBuffer()
      })

      this.onReady = () => {
        this.ready = true
        resolve()
      }
    })
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\r\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        this.handleMessage(msg)
      } catch {
        // try splitting on \n in case of plain newlines
        for (const subLine of line.split('\n')) {
          if (!subLine.trim()) continue
          try {
            this.handleMessage(JSON.parse(subLine))
          } catch { /* malformed */ }
        }
      }
    }

    // Also try plain \n split of remaining buffer
    const nlLines = this.buffer.split('\n')
    if (nlLines.length > 1) {
      this.buffer = nlLines.pop() || ''
      for (const nlLine of nlLines) {
        if (!nlLine.trim()) continue
        try {
          this.handleMessage(JSON.parse(nlLine))
        } catch { /* malformed */ }
      }
    }
  }

  private handleMessage(msg: any): void {
    if (msg.QMP) {
      this.greeting = msg
      this.sendRaw({ execute: 'qmp_capabilities' })
      return
    }

    if (msg.event) {
      // QMP async events (SHUTDOWN, STOP, etc.) -- log and ignore
      return
    }

    if (msg.return !== undefined || msg.error) {
      if (!this.ready && !msg.error) {
        // This is the response to qmp_capabilities
        this.onReady?.()
        this.onReady = null
        return
      }

      const pending = this.queue.shift()
      if (pending) {
        if (msg.error) {
          pending.reject(new Error(`QMP error: ${msg.error.class}: ${msg.error.desc}`))
        } else {
          pending.resolve(msg.return)
        }
      }
    }
  }

  async execute(command: string, args?: Record<string, any>): Promise<any> {
    if (!this.ready) throw new Error('QMP not connected')

    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      const msg: any = { execute: command }
      if (args) msg.arguments = args
      this.sendRaw(msg)
    })
  }

  async addPortForward(hostPort: number, guestPort: number, protocol = 'tcp'): Promise<void> {
    await this.execute('human-monitor-command', {
      'command-line': `hostfwd_add ${protocol}::${hostPort}-:${guestPort}`,
    })
  }

  async removePortForward(hostPort: number, protocol = 'tcp'): Promise<void> {
    await this.execute('human-monitor-command', {
      'command-line': `hostfwd_remove ${protocol}::${hostPort}`,
    })
  }

  async shutdown(): Promise<void> {
    await this.execute('system_powerdown')
  }

  async forceQuit(): Promise<void> {
    await this.execute('quit')
  }

  async queryStatus(): Promise<any> {
    return this.execute('query-status')
  }

  private sendRaw(msg: any): void {
    if (!this.socket) throw new Error('Not connected')
    this.socket.write(JSON.stringify(msg) + '\r\n')
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.ready = false
    for (const pending of this.queue) {
      pending.reject(new Error('Disconnected'))
    }
    this.queue = []
  }
}
