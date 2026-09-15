import { ShogoLiveClient } from '../live/client'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0
  sent: string[] = []
  private listeners = new Map<string, Set<(event: any) => void>>()

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.readyState = 3
    this.emit('close', {})
  }

  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  receive(event: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(event) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('ShogoLiveClient', () => {
  test('starts a relayed session and sends audio events', async () => {
    const client = new ShogoLiveClient({
      apiUrl: 'https://studio.example',
      apiKey: 'shogo_sk_test',
      WebSocket: FakeWebSocket as any,
    })
    const session = client.connect({ model: 'gpt-live-1', delegation: { type: 'client' } })
    const socket = FakeWebSocket.instances.at(-1)!

    socket.open()
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'session.start',
      session: { model: 'gpt-live-1', delegation: { type: 'client' } },
    })
    expect(socket.protocols[1]).toBe('shogo-insecure-api-key.shogo_sk_test')

    socket.receive({ type: 'session.started', session: { id: 'live_123' } })
    await expect(session.started).resolves.toMatchObject({ type: 'session.started' })

    session.appendAudio(new Uint8Array([0, 1]))
    expect(JSON.parse(socket.sent[1])).toEqual({
      type: 'session.input_audio.append',
      audio: 'AAE=',
    })

    const closing = session.close()
    expect(JSON.parse(socket.sent[2])).toEqual({ type: 'session.close' })
    socket.receive({ type: 'session.closed', usage: { seconds: 2 } })
    await closing
  })

  test('creates a WebRTC session through the authenticated HTTP endpoint', async () => {
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer shogo_sk_test' })
      return new Response(JSON.stringify({
        session: { id: 'live_456' },
        transport: { type: 'webrtc', sdp: 'answer' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const client = new ShogoLiveClient({
      apiUrl: 'https://studio.example',
      apiKey: 'shogo_sk_test',
      fetch: fetchImpl as typeof fetch,
      WebSocket: FakeWebSocket as any,
    })

    await expect(client.createWebRtcSession({
      session: { model: 'gpt-live-1' },
      sdp: 'offer',
    })).resolves.toMatchObject({ session: { id: 'live_456' } })
  })
})
