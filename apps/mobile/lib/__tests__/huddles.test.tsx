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
let connectOptions: any = null
let failure: Error | null = null

const huddle = (conversationId: string, userIds: string[]) => ({
  id: `h-${conversationId}`,
  conversationId,
  workspaceId: 'ws-1',
  startedById: userIds[0],
  startedAt: '2026-10-05T00:00:00.000Z',
  participants: userIds.map((userId) => ({ userId, name: userId, image: null, joinedAt: '2026-10-05T00:00:00.000Z' })),
  invited: [] as any[],
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
    inviteToHuddle: async (id: string, userIds: string[]) => {
      apiCalls.push(`invite:${id}:${userIds.join(',')}`)
      return { ...huddle(id, ['me']), invited: userIds.map((userId) => ({ userId, name: userId, image: null, status: 'ringing' })) }
    },
    cancelHuddleInvite: async (id: string, userId: string) => {
      apiCalls.push(`cancel-invite:${id}:${userId}`)
      return huddle(id, ['me'])
    },
    muteHuddleParticipant: async (id: string, userId: string) => {
      apiCalls.push(`mute:${id}:${userId}`)
      if (failure) throw failure
    },
    removeHuddleParticipant: async (id: string, userId: string) => {
      apiCalls.push(`remove:${id}:${userId}`)
      if (failure) throw failure
    },
    admitHuddleRequest: async (id: string, requestId: string) => {
      apiCalls.push(`admit:${id}:${requestId}`)
    },
    denyHuddleRequest: async (id: string, requestId: string) => {
      apiCalls.push(`deny:${id}:${requestId}`)
    },
    huddleLink: async (id: string) => {
      apiCalls.push(`link:${id}`)
      if (failure) throw failure
      return { token: 'tok_123' }
    },
    leaveHuddleAsGuest: async (requestId: string) => {
      apiCalls.push(`guest-leave:${requestId}`)
    },
    leaveHuddleAsGuestOnUnload: (requestId: string) => apiCalls.push(`guest-unload:${requestId}`),
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
  connectHuddleMedia: async (_url: string, token: string, h: any, options: any) => {
    mediaCalls.push(`connect:${token}`)
    if (mediaFailure) throw mediaFailure
    handlers = h
    connectOptions = options
    return {
      sendReaction: async (emoji: string) => void mediaCalls.push(`reaction:${emoji}`),
      setHandRaised: async (raised: boolean) => void mediaCalls.push(`hand:${raised}`),
      listDevices: async (kind: string) => [{ id: `${kind}-1`, label: `${kind} one`, kind }],
      getActiveDevice: (kind: string) => `${kind}-1`,
      switchDevice: async (kind: string, id: string) => {
        mediaCalls.push(`switch:${kind}:${id}`)
        if (failure) throw failure
      },
      setCameraEffects: async (effects: any) => void mediaCalls.push(`effects:${effects.background?.type ?? effects.background}`),
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
const prefsStore = await import('../huddle-prefs')

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
  connectOptions = null
  failure = null
  prefsStore._resetHuddlePrefsForTests()
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

describe('call surface', () => {
  const join = (conversationId = 'c-1') => call.joinHuddleCall({ conversationId, workspaceId: 'ws-1', label: `#${conversationId}` })

  test('the view changes between expanded, mini and pill, and the next call opens in the one you last chose', async () => {
    await join()
    call.setHuddleView('expanded')
    expect(call.getHuddleCall().view).toBe('expanded')
    call.setHuddleView('pill')
    expect(call.getHuddleCall().view).toBe('pill')
    expect(prefsStore.getHuddlePrefs().view).toBe('pill')

    await call.leaveHuddleCall()
    await join('c-2')
    expect(call.getHuddleCall().view).toBe('pill')
  })

  test('layout and pin: pinning twice follows the speaker again', async () => {
    await join()
    call.setHuddleLayout('speaker')
    expect(call.getHuddleCall().layout).toBe('speaker')
    call.pinHuddleParticipant('pat')
    expect(call.getHuddleCall().pinned).toBe('pat')
    call.pinHuddleParticipant('pat')
    expect(call.getHuddleCall().pinned).toBeNull()
  })

  test('reactions from the room float over the call, and ours go out through the data channel (quick repeats are dropped)', async () => {
    await join()
    handlers.onReaction({ id: 'r1', userId: 'pat', name: 'Pat', emoji: '🎉', at: Date.now() })
    expect(call.getHuddleCall().reactions.map((r) => r.emoji)).toEqual(['🎉'])

    await call.sendHuddleReaction('👍')
    await call.sendHuddleReaction('👏')
    expect(mediaCalls.filter((c) => c.startsWith('reaction:'))).toEqual(['reaction:👍'])
  })

  test('raising and lowering a hand is shown at once and sent to the room', async () => {
    await join()
    await call.setHuddleHand(true)
    expect(call.getHuddleCall().handRaised).toBe(true)
    await call.setHuddleHand(false)
    expect(call.getHuddleCall().handRaised).toBe(false)
    expect(mediaCalls.filter((c) => c.startsWith('hand:'))).toEqual(['hand:true', 'hand:false'])

    handlers.onParticipants([{ userId: 'me', isLocal: true, handRaisedAt: 5 }])
    expect(call.getHuddleCall().handRaised).toBe(true)
  })

  test('picking a device switches it now and is remembered for the next call', async () => {
    await join()
    expect(await call.listHuddleDevices('audioinput')).toEqual([{ id: 'audioinput-1', label: 'audioinput one', kind: 'audioinput' }])
    expect(call.activeHuddleDevice('videoinput')).toBe('videoinput-1')

    await call.switchHuddleDevice('audioinput', 'mic-2')
    await call.switchHuddleDevice('videoinput', 'cam-2')
    await call.switchHuddleDevice('audiooutput', 'spk-2')
    expect(mediaCalls).toEqual(expect.arrayContaining(['switch:audioinput:mic-2', 'switch:videoinput:cam-2', 'switch:audiooutput:spk-2']))
    expect(prefsStore.getHuddlePrefs()).toMatchObject({ micId: 'mic-2', cameraId: 'cam-2', speakerId: 'spk-2' })

    await call.leaveHuddleCall()
    await join('c-2')
    expect(connectOptions).toMatchObject({ micId: 'mic-2', cameraId: 'cam-2', speakerId: 'spk-2' })
  })

  test('a device that will not switch says so without ending the call', async () => {
    await join()
    failure = new Error('That camera is in use')
    await call.switchHuddleDevice('videoinput', 'cam-3')
    expect(call.getHuddleCall()).toMatchObject({ status: 'connected', notice: 'That camera is in use' })
    call.clearHuddleNotice()
    expect(call.getHuddleCall().notice).toBeNull()
  })

  test('a background effect is remembered, applied now, and reused when the next call connects', async () => {
    await join()
    call.setHuddleBackground({ type: 'blur', radius: 12 } as any)
    call.setHuddleAutoFraming(true)
    call.setHuddleLowLight(true)
    expect(prefsStore.getHuddlePrefs()).toMatchObject({ autoFraming: true, lowLight: true })
    expect(mediaCalls.filter((c) => c.startsWith('effects:'))).toHaveLength(3)

    await call.leaveHuddleCall()
    await join('c-2')
    expect(connectOptions.effects).toMatchObject({ background: { type: 'blur' }, autoFraming: true, lowLight: true })
  })
})

describe('people in the call', () => {
  const join = () => call.joinHuddleCall({ conversationId: 'c-1', workspaceId: 'ws-1', label: '#c-1' })

  test('inviting rings more people and shows them as ringing; taking an invite back removes them', async () => {
    const { result } = renderHook(() => useConversationHuddle('ws-1', 'c-1'))
    await join()
    await act(() => call.inviteToHuddleCall(['ana', 'ben']))
    expect(apiCalls).toContain('invite:c-1:ana,ben')
    expect(result.current.huddle?.invited.map((i) => [i.userId, i.status])).toEqual([['ana', 'ringing'], ['ben', 'ringing']])

    await act(() => call.cancelHuddleCallInvite('ben'))
    expect(apiCalls).toContain('cancel-invite:c-1:ben')
    expect(result.current.huddle?.invited).toEqual([])
  })

  test('inviting needs a call to be in', async () => {
    await expect(call.inviteToHuddleCall(['ana'])).rejects.toThrow('Join the huddle first')
    expect(apiCalls).toEqual([])
  })

  test('moderation reaches the server, and a refusal shows why', async () => {
    await join()
    await call.muteHuddleParticipant('pat')
    await call.removeHuddleParticipant('kim')
    expect(apiCalls).toEqual(expect.arrayContaining(['mute:c-1:pat', 'remove:c-1:kim']))

    failure = new Error('Only the host can remove people')
    await call.removeHuddleParticipant('kim')
    expect(call.getHuddleCall().notice).toBe('Only the host can remove people')
  })

  test('admitting and declining a knock go to the server', async () => {
    await join()
    await call.admitHuddleRequest('req-1')
    await call.denyHuddleRequest('req-2')
    expect(apiCalls).toEqual(expect.arrayContaining(['admit:c-1:req-1', 'deny:c-1:req-2']))
  })

  test('the share link is the join page for the huddle, and a failure explains itself', async () => {
    await join()
    expect(await call.getHuddleShareLink()).toMatch(/\/huddle\/join\/tok_123$/)
    failure = new Error('Links are turned off')
    expect(await call.getHuddleShareLink()).toBeNull()
    expect(call.getHuddleCall().notice).toBe('Links are turned off')
  })
})

describe('guest in a huddle link call', () => {
  const guestJoin = () => call.joinHuddleAsGuest({ token: 'guest-token', url: 'wss://lk.test', requestId: 'req-9', name: 'Gus' })

  test('a guest connects with the token they were handed, in the full call view, with no conversation behind it', async () => {
    await guestJoin()
    expect(call.getHuddleCall()).toMatchObject({ status: 'connected', view: 'expanded', conversationId: null, workspaceId: null, guest: { requestId: 'req-9', name: 'Gus' } })
    expect(mediaCalls).toEqual(['connect:guest-token'])
    expect(apiCalls).toEqual([])
  })

  test('leaving as a guest closes the room and tells the server which request ended', async () => {
    await guestJoin()
    await call.leaveHuddleCall()
    expect(call.getHuddleCall()).toMatchObject({ status: 'idle', guest: null })
    expect(mediaCalls).toContain('disconnect:guest-token')
    expect(apiCalls).toEqual(['guest-leave:req-9'])
  })

  test('a guest the room drops is told why and released', async () => {
    await guestJoin()
    handlers.onDropped('You were removed from the huddle')
    await settle()
    expect(call.getHuddleCall()).toMatchObject({ status: 'idle', guest: null, error: 'You were removed from the huddle' })
    expect(apiCalls).toEqual(['guest-leave:req-9'])
  })

  test('a guest whose microphone fails ends up out of the call with the reason', async () => {
    mediaFailure = new Error('Shogo needs microphone access to join a huddle')
    await guestJoin()
    expect(call.getHuddleCall()).toMatchObject({ status: 'idle', guest: null, error: 'Shogo needs microphone access to join a huddle' })
    expect(apiCalls).toEqual(['guest-leave:req-9'])
  })
})

describe('invitations', () => {
  const invite = (conversationId = 'c-1') => ({
    type: 'huddle.ring',
    conversationId,
    conversationKind: 'channel',
    conversationName: 'design',
    invite: true,
    huddleId: `h-${conversationId}`,
    from: { userId: 'ana', name: 'Ana', image: null },
  })

  test('being invited into a channel huddle rings with the inviter and the channel, and answering joins it', async () => {
    const { result } = renderHook(() => ringStore.useIncomingRings())
    act(() => ringStore.applyRingEvent('ws-1', invite() as any, 'me'))
    expect(result.current[0]).toMatchObject({ invite: true, conversationName: 'design', from: { name: 'Ana' } })
    expect(ringStore.ringLabel(result.current[0] as any)).toBe('#design')

    await act(() => ringStore.answerRing(result.current[0]))
    expect(call.getHuddleCall()).toMatchObject({ status: 'connected', conversationId: 'c-1', label: '#design' })
  })

  test('an invitation that is taken back, or answered elsewhere, stops ringing', () => {
    const { result } = renderHook(() => ringStore.useIncomingRings())
    const live = (invited: any[], participants: string[] = ['ana']) => ({ ...huddle('c-1', participants), invited })

    act(() => ringStore.applyRingEvent('ws-1', invite() as any, 'me'))
    act(() => ringStore.applyRingEvent('ws-1', { type: 'huddle.updated', conversationId: 'c-1', huddle: live([{ userId: 'me', name: 'Me', image: null, status: 'ringing' }]) } as any, 'me'))
    expect(result.current).toHaveLength(1)

    act(() => ringStore.applyRingEvent('ws-1', { type: 'huddle.updated', conversationId: 'c-1', huddle: live([]) } as any, 'me'))
    expect(result.current).toHaveLength(0)

    act(() => ringStore.applyRingEvent('ws-1', invite() as any, 'me'))
    act(() => ringStore.applyRingEvent('ws-1', { type: 'huddle.updated', conversationId: 'c-1', huddle: live([], ['ana', 'me']) } as any, 'me'))
    expect(result.current).toHaveLength(0)
  })

  test('people you invite yourself never ring you', () => {
    const { result } = renderHook(() => ringStore.useIncomingRings())
    act(() => ringStore.applyRingEvent('ws-1', { ...invite(), from: { userId: 'me', name: 'Me', image: null } } as any, 'me'))
    expect(result.current).toHaveLength(0)
  })
})
