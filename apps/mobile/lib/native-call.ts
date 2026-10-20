// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Incoming huddle calls on the system call screen (CallKit on iPhone,
 * ConnectionService on Android). This is the web and desktop version, where
 * there is no system call screen: every function does nothing. The phone
 * version is `native-call.native.ts`.
 */
import type { ConversationKind } from './team-chat-api'

export interface NativeCallRing {
  huddleId: string
  conversationId: string
  workspaceId: string
  kind: ConversationKind
  from: { userId: string; name: string; image: string | null }
}

/** Why a system call screen is closed without the person answering it here. */
export type NativeCallEndReason = 'answered_elsewhere' | 'declined_elsewhere' | 'missed' | 'remote_ended'

export interface NativeCallHandlers {
  /** Answered on the system call screen: join the huddle. */
  onAnswer(ring: NativeCallRing): void
  /** Declined on the system call screen. */
  onDecline(ring: NativeCallRing): void
  /** Ended on the system call screen while in the huddle: leave it. */
  onHangUp(ring: NativeCallRing): void
}

export const nativeCallsSupported = false

export function setNativeCallHandlers(_handlers: NativeCallHandlers | null): void {}

/** Shows the incoming call. Returns false when there is no system call screen here. */
export function showNativeIncomingCall(_ring: NativeCallRing): boolean {
  return false
}

/** True while the system call screen is ringing for this huddle. Never here: there is no system screen. */
export function hasSystemCall(_huddleId: string): boolean {
  return false
}

/** The call was answered in the app, so the system call screen stays up while the huddle runs. */
export function markNativeCallAnswered(_huddleId: string): void {}

/** Closes the system call screen for a ring that is still unanswered. Answered calls are left alone. */
export function endNativeCall(_huddleId: string, _reason: NativeCallEndReason = 'remote_ended'): void {}
