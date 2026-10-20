// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native (iOS / Android) stand-in for `notification-sound.ts`. Phones play the
 * system push sound, so the in-app engine does nothing here.
 */

export type MessageSoundKind = 'dm' | 'mention' | 'thread' | 'other'
export type MessageSoundLevel = 'default' | 'subtle' | 'off'

export interface Tone {
  frequency: number
  start: number
  duration: number
  type?: OscillatorType
}

export const MESSAGE_SOUND_THROTTLE_MS = 1_500

export function sharedAudioContext(): AudioContext | null {
  return null
}

export function unlockNotificationAudio(): void {}

export function notificationAudioReady(): boolean {
  return false
}

export function scheduleTones(_ctx: AudioContext, _tones: Tone[], _peak: number): void {}

export function playMessageSound(
  _kind: MessageSoundKind,
  _level: MessageSoundLevel,
  _now?: number,
): boolean {
  return false
}

export function previewMessageSound(_level: MessageSoundLevel): boolean {
  return false
}

export function messageSoundKindFor(reason: string | null | undefined): MessageSoundKind {
  switch (reason) {
    case 'dm':
    case 'group_dm':
      return 'dm'
    case 'mention':
    case 'broadcast':
      return 'mention'
    case 'thread':
      return 'thread'
    default:
      return 'other'
  }
}

export function _resetNotificationAudioForTests(): void {}
