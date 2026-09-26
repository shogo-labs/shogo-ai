import { describe, expect, mock, test } from 'bun:test'

// A single synchronous "render" is enough to drive the hook: its behavior
// lives in callbacks and refs, not in re-render output.
mock.module('react', () => ({
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}))

class FakeDataChannel {
  readyState = 'open'
  sent: any[] = []
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(message: string) {
    this.sent.push(JSON.parse(message))
  }
  close() {
    this.readyState = 'closed'
  }
}

class FakePeerConnection {
  static last: FakePeerConnection
  channel = new FakeDataChannel()
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: { sdp: string } | null = null
  ontrack: unknown = null
  onconnectionstatechange: unknown = null
  constructor() {
    FakePeerConnection.last = this
  }
  addTrack() {}
  createDataChannel() {
    return this.channel
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' }
  }
  async setLocalDescription(offer: { sdp: string }) {
    this.localDescription = offer
  }
  async setRemoteDescription() {}
  close() {}
}

Object.assign(globalThis, {
  window: globalThis,
  RTCPeerConnection: FakePeerConnection,
  navigator: {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }),
    },
  },
})

const { useLiveVoiceConversation } = await import('../react/useLiveVoiceConversation')

async function connect(options: Partial<Parameters<typeof useLiveVoiceConversation>[0]> = {}) {
  const conversation = useLiveVoiceConversation({
    mintSession: async () => ({ sessionId: 'live-1', sdp: 'answer-sdp' }),
    ...options,
  })
  await conversation.start()
  const channel = FakePeerConnection.last.channel
  const receive = async (event: Record<string, unknown>) => {
    channel.onmessage?.({ data: JSON.stringify(event) })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { conversation, channel, receive }
}

describe('useLiveVoiceConversation client delegation', () => {
  test('answers a delegation with the transcript and returns spoken commentary', async () => {
    const onDelegation = mock(async () => 'I queued the blue header change.')
    const onMessage = mock(() => {})
    const { conversation, channel, receive } = await connect({ onDelegation, onMessage })

    await receive({ type: 'session.output_transcript.delta', delta: 'Hi, what should we build?' })
    await receive({ type: 'session.output_transcript.done' })
    await receive({ type: 'session.input_transcript.delta', delta: 'Make the header ' })
    await receive({ type: 'session.input_transcript.delta', delta: 'blue.' })
    await receive({
      type: 'session.delegation.created',
      delegation: { id: 'item_1', type: 'delegation', target: 'client' },
    })

    const transcript = [
      { role: 'assistant', text: 'Hi, what should we build?' },
      { role: 'user', text: 'Make the header blue.' },
    ]
    expect(onDelegation).toHaveBeenCalledWith({ delegationId: 'item_1', transcript })
    expect(onMessage).toHaveBeenCalledWith({ source: 'user', message: 'Make the header blue.' })
    expect(channel.sent.at(-1)).toEqual({
      type: 'session.commentary.append',
      delegation_id: 'item_1',
      content: 'I queued the blue header change.',
    })
    expect(conversation.getTranscript()).toEqual(transcript)
  })

  test('ignores Responses delegations and empty results', async () => {
    const onDelegation = mock(async () => null)
    const { channel, receive } = await connect({ onDelegation })

    await receive({ type: 'session.delegation.created', delegation: { id: 'r1', target: 'responses' } })
    expect(onDelegation).not.toHaveBeenCalled()

    await receive({ type: 'session.delegation.created', delegation: { id: 'c1', target: 'client' } })
    expect(onDelegation).toHaveBeenCalledTimes(1)
    expect(channel.sent.filter((e) => e.type === 'session.commentary.append')).toHaveLength(0)
  })

  test('reports handler failures and tells GPT-Live nothing was confirmed', async () => {
    const onError = mock(() => {})
    const { channel, receive } = await connect({
      onDelegation: async () => { throw new Error('thinker down') },
      onError,
    })

    await receive({ type: 'session.delegation.created', delegation: { id: 'c2', target: 'client' } })

    expect(onError).toHaveBeenCalled()
    expect(channel.sent.at(-1)).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: 'c2',
    })
    expect(channel.sent.at(-1).content).toMatch(/nothing was confirmed/i)
  })

  test('splits long results across commentary appends for the same delegation', async () => {
    const { channel, receive } = await connect({ onDelegation: async () => 'x'.repeat(4000) })

    await receive({ type: 'session.delegation.created', delegation: { id: 'c3', target: 'client' } })

    const appends = channel.sent.filter((e) => e.type === 'session.commentary.append')
    expect(appends.map((e) => e.content.length)).toEqual([1800, 1800, 400])
    expect(appends.every((e) => e.delegation_id === 'c3')).toBe(true)
  })
})
