// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** A WebSocket the test drives by hand, standing in for the live-transcript server. */
export class FakeSocket {
  static instances: FakeSocket[] = []
  /** What the next socket does when opened: reply `ready`, refuse, or stay silent. */
  static behavior: 'ready' | 'error' | 'silent' = 'ready'

  binaryType = ''
  sent: Array<ArrayBuffer | string> = []
  closed = false
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
    queueMicrotask(() => {
      if (FakeSocket.behavior === 'ready') this.receive({ type: 'ready', backend: 'openai' })
      else if (FakeSocket.behavior === 'error') this.onerror?.()
    })
  }

  static reset(behavior: 'ready' | 'error' | 'silent' = 'ready') {
    FakeSocket.instances = []
    FakeSocket.behavior = behavior
  }

  static get last(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1]
  }

  send(data: ArrayBuffer | string) {
    this.sent.push(data)
    // Answer a finish request like the server does.
    if (typeof data === 'string' && JSON.parse(data).type === 'finish') {
      queueMicrotask(() => this.receive({ type: 'done', complete: true, chunks: 2, seconds: this.audioSeconds() }))
    }
  }

  close() {
    this.closed = true
    this.onclose?.()
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  /** The server went away. */
  drop() {
    this.onclose?.()
  }

  audioSeconds(): number {
    return this.sent.reduce<number>((total, item) => total + (typeof item === 'string' ? 0 : item.byteLength / 2 / 16000), 0)
  }
}
