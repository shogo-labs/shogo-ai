// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Incoming huddle calls on the system call screen: CallKit on iPhone, rung by
 * a PushKit VoIP push (Apple requires the call to be reported at once, so the
 * handler here does nothing slow), and the Android phone-account screen, rung
 * by a data push (see `native-call-background.native.ts`).
 *
 * This module owns the system screen for each ring. Answer and decline on the
 * system screen reach `huddle-ring` through the handlers; closing a ring in the
 * app ends its system screen. An answered call stays up until the huddle ends.
 */
import { NativeModules, Platform } from 'react-native'
import { randomUUID } from 'expo-crypto'
import { api, createHttpClient } from './api'
import { getHuddleCall, subscribeHuddleCall } from './huddle-call'
import { subscribeAnnounceHuddleCalls } from './notifications/huddle-call-prefs'
import { subscribePushToken } from './notifications/mobile-push-registration'
import type { NativeCallEndReason, NativeCallHandlers, NativeCallRing } from './native-call'
import { ringFromPushData } from './native-call-payload'

export type { NativeCallEndReason, NativeCallHandlers, NativeCallRing } from './native-call'

type CallKeepModule = typeof import('react-native-callkeep')
type CallKeep = CallKeepModule['default']
type VoipPush = (typeof import('react-native-voip-push-notification'))['default']
type LiveKitNative = typeof import('@livekit/react-native')

function loadCallKeep(): CallKeepModule | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null
  // Builds from before the native module shipped don't have it: calls then stay in the app.
  if (!NativeModules.RNCallKeep) return null
  try {
    return require('react-native-callkeep') as CallKeepModule
  } catch (err) {
    console.warn('[Huddles] CallKeep unavailable:', (err as Error).message)
    return null
  }
}

function loadVoipPush(): VoipPush | null {
  if (Platform.OS !== 'ios' || !NativeModules.RNVoipPushNotificationManager) return null
  try {
    return (require('react-native-voip-push-notification') as { default: VoipPush }).default
  } catch (err) {
    console.warn('[Huddles] VoIP push unavailable:', (err as Error).message)
    return null
  }
}

function loadLiveKit(): LiveKitNative | null {
  if (!NativeModules.WebRTCModule) return null
  try {
    return require('@livekit/react-native') as LiveKitNative
  } catch {
    return null
  }
}

const callKeepModule = loadCallKeep()
const callKeep: CallKeep | null = callKeepModule?.default ?? null
const voipPush = loadVoipPush()

export const nativeCallsSupported = callKeep !== null

/** How long an unanswered call stays on the system screen. Clients and the server use the same window. */
const NATIVE_RING_MS = 45_000

interface ActiveCall {
  uuid: string
  ring: NativeCallRing
  answered: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/** System-screen calls by huddle, and the other way round. */
const callsByHuddle = new Map<string, ActiveCall>()
const huddleByUuid = new Map<string, string>()
type SystemAction = 'answer' | 'end'
const earlySystemActions = new Map<string, { actions: SystemAction[]; timer: ReturnType<typeof setTimeout> }>()

let handlers: NativeCallHandlers | null = null
/** Answers and declines that came in before the app's handlers were set (a call that opened the app). */
let pending: Array<{ action: 'answer' | 'decline' | 'hangup'; ring: NativeCallRing }> = []

function forget(call: ActiveCall): void {
  if (call.timer) clearTimeout(call.timer)
  call.timer = null
  callsByHuddle.delete(call.ring.huddleId)
  huddleByUuid.delete(call.uuid)
}

function dispatch(action: 'answer' | 'decline' | 'hangup', ring: NativeCallRing): void {
  if (!handlers) {
    pending.push({ action, ring })
    return
  }
  if (action === 'answer') handlers.onAnswer(ring)
  else if (action === 'decline') handlers.onDecline(ring)
  else handlers.onHangUp(ring)
}

function endReasonCode(reason: NativeCallEndReason): number {
  const codes = (callKeepModule as CallKeepModule | null)?.CONSTANTS.END_CALL_REASONS
  if (!codes) return 0
  switch (reason) {
    case 'answered_elsewhere':
      return codes.ANSWERED_ELSEWHERE
    case 'declined_elsewhere':
      return codes.DECLINED_ELSEWHERE
    case 'missed':
      return codes.MISSED
    case 'remote_ended':
      return codes.REMOTE_ENDED
  }
}

function reportEnd(call: ActiveCall, reason: NativeCallEndReason): void {
  callKeep?.reportEndCallWithUUID(call.uuid, endReasonCode(reason))
}

export function setNativeCallHandlers(next: NativeCallHandlers | null): void {
  handlers = next
  if (!next) return
  const queued = pending
  pending = []
  for (const { action, ring } of queued) dispatch(action, ring)
}

/** Shows the call on the system screen right away. Returns false if this build has no system call screen. */
export function showNativeIncomingCall(
  ring: NativeCallRing,
  options: { callUUID?: string; alreadyReportedByPushKit?: boolean } = {},
): boolean {
  if (!callKeep) return false
  if (callsByHuddle.has(ring.huddleId)) return true
  const stableUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ring.huddleId)
    ? ring.huddleId.toLowerCase()
    : null
  const uuid = options.callUUID ?? stableUUID ?? randomUUID()
  const call: ActiveCall = { uuid, ring, answered: false, timer: null }
  callsByHuddle.set(ring.huddleId, call)
  huddleByUuid.set(uuid, ring.huddleId)
  // Nobody answers: the call stops on its own, as the server's ring does.
  call.timer = setTimeout(() => endNativeCall(ring.huddleId, 'missed'), NATIVE_RING_MS)
  const name = ring.from.name
  if (!options.alreadyReportedByPushKit) {
    callKeep.displayIncomingCall(uuid, name, ring.kind === 'dm' ? name : `${name}'s huddle`, 'generic', false)
  }
  replayEarlySystemActions(uuid)
  return true
}

/** The ring was answered in the app: the system screen becomes an active call, and stays until the huddle ends. */
export function markNativeCallAnswered(huddleId: string): void {
  const call = callsByHuddle.get(huddleId)
  if (!call || call.answered) return
  call.answered = true
  if (call.timer) clearTimeout(call.timer)
  call.timer = null
  callKeep?.setCurrentCallActive(call.uuid)
}

/** True while the system call screen is ringing for this huddle. The in-app ring then stays quiet. */
export function hasSystemCall(huddleId: string): boolean {
  return callsByHuddle.has(huddleId)
}

/** Closes the system screen for a ring nobody has answered. Answered calls are left to the huddle. */
export function endNativeCall(huddleId: string, reason: NativeCallEndReason = 'remote_ended'): void {
  const call = callsByHuddle.get(huddleId)
  if (!call || call.answered) return
  forget(call)
  reportEnd(call, reason)
}

/** The huddle is over (or we left it): close every answered system call. */
function endAnsweredCalls(): void {
  for (const call of [...callsByHuddle.values()]) {
    if (!call.answered) continue
    forget(call)
    reportEnd(call, 'remote_ended')
  }
}

// CallKit can deliver an answer before PushKit's cached payload reaches JS.
function queueEarlySystemAction(uuid: string, action: SystemAction): void {
  if (Platform.OS !== 'ios') return
  const queued = earlySystemActions.get(uuid)
  if (queued) {
    queued.actions.push(action)
    return
  }
  const timer = setTimeout(() => earlySystemActions.delete(uuid), NATIVE_RING_MS)
  earlySystemActions.set(uuid, { actions: [action], timer })
}

function replayEarlySystemActions(uuid: string): void {
  const queued = earlySystemActions.get(uuid)
  if (!queued) return
  earlySystemActions.delete(uuid)
  clearTimeout(queued.timer)
  for (const action of queued.actions) {
    if (action === 'answer') onSystemAnswer(uuid)
    else onSystemEnd(uuid)
  }
}

function onSystemAnswer(uuid: string): void {
  const huddleId = huddleByUuid.get(uuid)
  const call = huddleId ? callsByHuddle.get(huddleId) : undefined
  if (!call) {
    queueEarlySystemAction(uuid, 'answer')
    return
  }
  markNativeCallAnswered(call.ring.huddleId)
  dispatch('answer', call.ring)
}

/** Ended on the system screen. The screen we close ourselves is forgotten first, so it doesn't come back here. */
function onSystemEnd(uuid: string): void {
  const huddleId = huddleByUuid.get(uuid)
  const call = huddleId ? callsByHuddle.get(huddleId) : undefined
  if (!call) {
    queueEarlySystemAction(uuid, 'end')
    return
  }
  forget(call)
  dispatch(call.answered ? 'hangup' : 'decline', call.ring)
}

function activateAudio(): void {
  const liveKit = loadLiveKit()
  if (!liveKit) return
  // CallKit has activated the audio session for the call; hand it to LiveKit.
  void liveKit.AudioSession.startAudioSession().catch(() => {})
}

function setupCallKit(): void {
  if (!callKeep) return
  void callKeep
    .setup({
      ios: { appName: 'Shogo', supportsVideo: false, maximumCallGroups: '1' },
      android: {
        alertTitle: 'Allow Shogo to manage calls',
        alertDescription: 'Shogo shows incoming huddles on the call screen.',
        cancelButton: 'Not now',
        okButton: 'Allow',
        additionalPermissions: [],
        foregroundService: {
          channelId: 'huddle-calls-active',
          channelName: 'Huddle calls',
          notificationTitle: 'Shogo huddle in progress',
        },
      },
    })
    .catch((err: unknown) => console.warn('[Huddles] CallKeep setup failed:', (err as Error).message))
  if (Platform.OS === 'android') callKeep.setAvailable(true)
  if (Platform.OS === 'ios') {
    callKeep.addEventListener('didLoadWithEvents', (events) => {
      for (const event of events) {
        if (event.name === 'RNCallKeepPerformAnswerCallAction') onSystemAnswer(event.data.callUUID)
        else if (event.name === 'RNCallKeepPerformEndCallAction') onSystemEnd(event.data.callUUID)
        else if (event.name === 'RNCallKeepDidActivateAudioSession') activateAudio()
      }
    })
  }
  callKeep.addEventListener('answerCall', ({ callUUID }) => onSystemAnswer(callUUID))
  callKeep.addEventListener('endCall', ({ callUUID }) => onSystemEnd(callUUID))
  callKeep.addEventListener('didActivateAudioSession', () => activateAudio())
}

// ---------------------------------------------------------------------------
// PushKit: the VoIP token for this iPhone, kept on the server with the Expo token.
// ---------------------------------------------------------------------------

let voipToken: string | null = null
let expoPushToken: string | null = null
let announce = true
let voipTokenState: 'unknown' | 'registered' | 'invalidated' = 'unknown'

async function syncVoipToken(): Promise<void> {
  if (!expoPushToken || voipTokenState === 'unknown') return
  await api
    .putVoipToken(createHttpClient(), {
      pushToken: expoPushToken,
      voipToken: voipTokenState === 'registered' && announce ? voipToken : null,
    })
    .catch(() => {})
}

/** "Announce huddle calls" off: the server stops sending this iPhone VoIP calls. */
export function setAnnounceHuddleCalls(enabled: boolean): void {
  announce = enabled
  void syncVoipToken()
}

function onVoipPush(payload: Record<string, unknown>): void {
  const ring = ringFromPushData(payload)
  if (!ring) return

  const callUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ring.huddleId)
    ? ring.huddleId.toLowerCase()
    : undefined
  if (callUUID) showNativeIncomingCall(ring, { callUUID, alreadyReportedByPushKit: true })
}

function onVoipRegistration(token: string): void {
  voipToken = token.trim() || null
  voipTokenState = voipToken ? 'registered' : 'invalidated'
  void syncVoipToken()
}

function startVoip(): void {
  if (!voipPush) return
  voipPush.addEventListener('didLoadWithEvents', (events) => {
    for (const event of events) {
      if (event.name === voipPush.RNVoipPushRemoteNotificationsRegisteredEvent) onVoipRegistration(event.data)
      else if (event.name === voipPush.RNVoipPushRemoteNotificationReceivedEvent) {
        onVoipPush(event.data as Record<string, unknown>)
      }
    }
  })
  voipPush.addEventListener('register', onVoipRegistration)
  voipPush.addEventListener('notification', (payload: object) => onVoipPush(payload as Record<string, unknown>))
  voipPush.registerVoipToken()
}

// Start once, when the module loads, so a call that opens the app is not missed.
setupCallKit()
startVoip()
subscribePushToken((token) => {
  expoPushToken = token
  void syncVoipToken()
})
subscribeHuddleCall(() => {
  if (getHuddleCall().status === 'idle') endAnsweredCalls()
})
subscribeAnnounceHuddleCalls((enabled) => setAnnounceHuddleCalls(enabled))
