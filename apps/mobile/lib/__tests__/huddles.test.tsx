// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live huddle rosters follow `huddle.updated` events, and the app-wide call
 * joins one huddle at a time, cleans up after failures and drops, and never
 * lets an abandoned join come back.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

const apiCalls: string[] = []
let listResult: { enabled: boolean; huddles: any[] } = { enabled: true, huddles: [] }
let joinGate: Promise<void> = Promise.resolve()
let emit: (event: any) => void = () => {}

const mediaCalls: string[] = []
let mediaFailure: Error | null = null
let cameraFailure: Error | null = null
let handlers: any = null

const huddle = (conversationId: string, userIds: string[]) => ({
  id: `h-${conversationId}`,
  conversationId,
  workspaceId: 'ws-1',
  startedById: userIds[0],
  startedAt: '2026-10-05T00:00:00.000Z',
  participants: userIds.map((userId) => ({ userId, name: userId, image: null, joinedAt: '2026-10-05T00:00:00.000Z' })),
})

const realApi = await import('../team-chat-api')
const realConnection = await import('../team-chat-connection')
mock.module('../team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({
    huddles: async () => {
      apiCalls.push('list')
      return listResult
    },
    joinHuddle: async (id: string) => {
      apiCalls.push(`join:${id}`)
      await joinGate
      return { huddle: huddle(id, ['me']), token: `token-${id}`, url: 'wss://lk.test' }
    },
    leaveHuddle: async (id: string) => {
      apiCalls.push(`leave:${id}`)
      return null
    },
    leaveHuddleOnUnload: (id: string) => apiCalls.push(`unload:${id}`),
    declineHuddle: async (id: string) => {
      apiCalls.push(`decline:${id}`)
      return null
    },
  }),
}))
mock.module('../team-chat-connection', () => ({
  ...realConnection,
  useTeamChatEvents: (_workspaceId: string, onEvent: (event: any) => void) => {
    emit = onEvent
    return 'open'
  },
}))
mock.module('../huddle-media', () => ({
  huddleMediaSupported: true,
  huddleVideoSupported: true,
  screenShareSupported: true,
  connectHuddleMedia: async (_url: string, token: string, h: any) => {
    mediaCalls.push(`connect:${token}`)
    if (mediaFailure) throw mediaFailure
    handlers = h
    return {
      setMuted: async (muted: boolean) => void mediaCalls.push(`muted:${muted}`),
      setCamera: async (on: boolean) => {
        mediaCalls.push(`camera:${on}`)
        if (cameraFailure) throw cameraFailure
      },
      setScreenShare: async (on: boolean) => void mediaCalls.push(`screen:${on}`),
      resumePlayback: async () => {},
      disconnect: async () => void mediaCalls.push(`disconnect:${token}`),
    }
  },
}))

const { _resetHuddlesForTests, setConversationHuddle, useConversationHuddle } = await import('../../hooks/useHuddles')
const call = await import('../huddle-call')
const ringStore = await import('../huddle-ring')

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)))

beforeEach(async () => {
  await call.leaveHuddleCall()
  call.clearHuddleError()
  _resetHuddlesForTests()
  ringStore._resetRingsForTests()
  apiCalls.length = 0
  mediaCalls.length = 0
  mediaFailure = null
  cameraFailure = null
  handlers = null
  joinGate = Promise.resolve()
  listResult = { enabled: true, huddles: [] }
})
afterEach(cleanup)

describe('useConversationHuddle', () => {
  test('loads live huddles once and follows huddle.updated events', async () => {
    listResult = { enabled: true, huddles: [huddle('c-1', ['pat'])] }
    const { result } = renderHook(() => [useConversationHuddle('ws-1', 'c-1'), useConversationHuddle('ws-1', 'c-2')])
    await settle()
    expect(apiCalls).toEqual(['list'])
    expect(result.current[0].enabled).toBe(true)
    expect(result.current[0].huddle?.participants.map((p) => p.userId)).toEqual(['pat'])
    expect(result.current[1].huddle).toBeNull()

    act(() => emit({ type: 'huddle.updated', conversationId: 'c-2', huddle: huddle('c-2', ['sam', 'kim']) }))
    expect(result.current[1].huddle?.participants).toHaveLength(2)
    act(() => emit({ type: 'huddle.updated', conversationId: 'c-1', huddle: null }))
    expect(result.current[0].huddle).toBeNull()
  })

  test('reports huddles as off when the server has no LiveKit', async () => {
    listResult = { enabled: false, huddles: [] }
    const { result } = renderHook(() => useConversationHuddle('ws-1', 'c-1'))
    await settle()
    expect(result.current.enabled).toBe(false)
  })
})

describe('huddle call', () => {
  const join = (conversationId: string) => call.joinHuddleCall({ conversationId, workspaceId: 'ws-1', label: `#${conversationId}` })

  test('joining connects media with the room token, and leaving disconnects and tells the server', async () => {
    await join('c-1')
    expect(call.getHuddleCall()).toMatchObject({ status: 'connected', conversationId: 'c-1', label: '#c-1' })
    expect(mediaCalls).toEqual(['connect:token-c-1'])

    await call.setHuddleMuted(true)
    expect(call.getHuddleCall().muted).toBe(true)
    expect(mediaCalls).toContain('muted:true')

    await call.leaveHuddleCall()
    expect(call.getHuddleCall().status).toBe('idle')
    expect(mediaCalls).toContain('disconnect:token-c-1')
    expect(apiCalls).toEqual(['join:c-1', 'leave:c-1'])
  })

  test('joining another huddle leaves the current one first', async () => {
    await join('c-1')
    await join('c-2')
    expect(call.getHuddleCall().conversationId).toBe('c-2')
    expect(apiCalls).toEqual(['join:c-1', 'leave:c-1', 'join:c-2'])
    expect(mediaCalls).toEqual(['connect:token-c-1', 'disconnect:token-c-1', 'connect:token-c-2'])
  })

  test('a microphone failure leaves the huddle and shows why', async () => {
    mediaFailure = new Error('Shogo needs microphone access to join a huddle')
    await join('c-1')
    expect(call.getHuddleCall()).toMatchObject({ status: 'idle', error: 'Shogo needs microphone access to join a huddle' })
    expect(apiCalls).toEqual(['join:c-1', 'leave:c-1'])
  })

  test('being dropped by the room resets the call and leaves on the server', async () => {
    await join('c-1')
    handlers.onSpeakers(['pat'])
    expect(call.getHuddleCall().speaking).toEqual(['pat'])
    handlers.onDropped('You joined this huddle somewhere else')
    await settle()
    expect(call.getHuddleCall()).toMatchObject({ status: 'idle', error: 'You joined this huddle somewhere else' })
    expect(apiCalls).toEqual(['join:c-1', 'leave:c-1'])
  })

  test('leaving while still joining abandons the join', async () => {
    let release!: () => void
    joinGate = new Promise((r) => (release = r))
    const pending = join('c-1')
    expect(call.getHuddleCall().status).toBe('joining')
    await call.leaveHuddleCall()
    release()
    await pending
    expect(call.getHuddleCall().status).toBe('idle')
    expect(mediaCalls).toEqual([])
    expect(apiCalls.filter((c) => c === 'leave:c-1').length).toBeGreaterThanOrEqual(1)
  })

  test('camera and screen toggle through the media layer, and the stage follows its video tracks', async () => {
    await join('c-1')
    await call.setHuddleCamera(true)
    await call.setHuddleScreenShare(true)
    expect(call.getHuddleCall()).toMatchObject({ camera: true, screen: true })
    expect(mediaCalls).toEqual(['connect:token-c-1', 'camera:true', 'screen:true'])

    const tile = { key: 'pat:screen', userId: 'pat', name: 'Pat', source: 'screen', isLocal: false, track: {} }
    handlers.onVideo([tile])
    expect(call.getHuddleCall().video).toEqual([tile] as any)
    handlers.onLocalMedia({ camera: true, screen: false })
    expect(call.getHuddleCall().screen).toBe(false)

    await call.leaveHuddleCall()
    expect(call.getHuddleCall()).toMatchObject({ camera: false, screen: false, video: [] })
  })

  test('a camera that will not start turns back off and says why', async () => {
    await join('c-1')
    cameraFailure = new Error('Shogo needs camera access')
    await call.setHuddleCamera(true)
    expect(call.getHuddleCall()).toMatchObject({ status: 'connected', camera: false, error: 'Shogo needs camera access' })
  })

  test('a decline from the person you rang hangs up a 1:1 call and says so', async () => {
    await call.joinHuddleCall({ conversationId: 'd-1', workspaceId: 'ws-1', label: 'Pat', kind: 'dm' })
    call.applyCallEvent({ type: 'huddle.declined', conversationId: 'd-1', huddleId: 'h-d-1', userId: 'pat', name: 'Pat' })
    await settle()
    expect(call.getHuddleCall()).toMatchObject({ status: 'idle', error: 'Pat declined' })
    expect(apiCalls).toEqual(['join:d-1', 'leave:d-1'])
  })

  test('a decline that lands just after the room closed still explains the hang-up', async () => {
    await call.joinHuddleCall({ conversationId: 'd-3', workspaceId: 'ws-1', label: 'Pat', kind: 'dm' })
    handlers.onDropped('The huddle ended')
    await settle()
    call.applyCallEvent({ type: 'huddle.declined', conversationId: 'd-3', huddleId: 'h-d-3', userId: 'pat', name: 'Pat' })
    expect(call.getHuddleCall()).toMatchObject({ status: 'idle', error: 'Pat declined' })
  })

  test('a decline in a call others already joined changes nothing', async () => {
    await call.joinHuddleCall({ conversationId: 'd-2', workspaceId: 'ws-1', label: 'Pat', kind: 'dm' })
    setConversationHuddle('ws-1', 'd-2', huddle('d-2', ['me', 'kim']))
    call.applyCallEvent({ type: 'huddle.declined', conversationId: 'd-2', huddleId: 'h-d-2', userId: 'pat', name: 'Pat' })
    await settle()
    expect(call.getHuddleCall().status).toBe('connected')
  })
})

describe('incoming rings', () => {
  const ring = (conversationId: string, from = 'pat') => ({
    type: 'huddle.ring',
    conversationId,
    conversationKind: 'dm',
    huddleId: `h-${conversationId}`,
    from: { userId: from, name: from.toUpperCase(), image: null },
  })

  test('a ring shows until the huddle ends or you join it elsewhere; your own calls never ring', () => {
    const { result } = renderHook(() => ringStore.useIncomingRings())
    act(() => ringStore.applyRingEvent('ws-1', ring('d-1', 'me') as any, 'me'))
    expect(result.current).toHaveLength(0)

    act(() => ringStore.applyRingEvent('ws-1', ring('d-1') as any, 'me'))
    act(() => ringStore.applyRingEvent('ws-1', ring('d-2', 'kim') as any, 'me'))
    expect(result.current.map((r) => r.conversationId)).toEqual(['d-1', 'd-2'])
    expect(result.current[0]).toMatchObject({ workspaceId: 'ws-1', kind: 'dm', from: { name: 'PAT' } })

    act(() => ringStore.applyRingEvent('ws-1', { type: 'huddle.updated', conversationId: 'd-1', huddle: huddle('d-1', ['pat', 'me']) } as any, 'me'))
    expect(result.current.map((r) => r.conversationId)).toEqual(['d-2'])
    act(() => ringStore.applyRingEvent('ws-1', { type: 'huddle.updated', conversationId: 'd-2', huddle: null } as any, 'me'))
    expect(result.current).toHaveLength(0)
  })

  test('declining on another device stops the ring here', () => {
    const { result } = renderHook(() => ringStore.useIncomingRings())
    act(() => ringStore.applyRingEvent('ws-1', ring('d-1') as any, 'me'))
    act(() => ringStore.applyRingEvent('ws-1', { type: 'huddle.declined', conversationId: 'd-1', huddleId: 'h-d-1', userId: 'kim', name: 'Kim' } as any, 'me'))
    expect(result.current).toHaveLength(1)
    act(() => ringStore.applyRingEvent('ws-1', { type: 'huddle.declined', conversationId: 'd-1', huddleId: 'h-d-1', userId: 'me', name: 'Me' } as any, 'me'))
    expect(result.current).toHaveLength(0)
  })

  test('catching up rings for a fresh DM huddle once, and never for one already handled', () => {
    const { result } = renderHook(() => ringStore.useIncomingRings())
    const live = (id: string, startedAt: string, ringing = true) => ({
      ...huddle(id, ['pat']),
      startedAt,
      conversationKind: 'dm' as const,
      ringing,
    })
    const now = new Date().toISOString()
    act(() => ringStore.restoreRings('ws-1', [live('d-1', now), live('d-2', now, false), live('d-3', '2026-01-01T00:00:00.000Z')], 'me'))
    expect(result.current.map((r) => r.conversationId)).toEqual(['d-1'])
    expect(result.current[0].from).toMatchObject({ userId: 'pat', name: 'pat' })

    act(() => ringStore.dismissRing('d-1'))
    act(() => ringStore.restoreRings('ws-1', [live('d-1', now)], 'me'))
    act(() => ringStore.applyRingEvent('ws-1', ring('d-1') as any, 'me'))
    expect(result.current).toHaveLength(0)
  })

  test('answering joins the huddle and declining tells the server', async () => {
    const { result } = renderHook(() => ringStore.useIncomingRings())
    act(() => ringStore.applyRingEvent('ws-1', ring('d-1') as any, 'me'))
    await act(() => ringStore.answerRing(result.current[0], 'PAT'))
    expect(result.current).toHaveLength(0)
    expect(call.getHuddleCall()).toMatchObject({ status: 'connected', conversationId: 'd-1', kind: 'dm', label: 'PAT' })

    act(() => ringStore.applyRingEvent('ws-1', ring('d-2') as any, 'me'))
    await act(() => ringStore.declineRing(result.current[0]))
    expect(result.current).toHaveLength(0)
    expect(apiCalls).toContain('decline:d-2')
  })
})
