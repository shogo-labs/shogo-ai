// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  HUDDLE_EXPANDED_SIZE,
  HUDDLE_MINI_SIZE,
  clampToArea,
  huddleBounds,
  parseHuddleCommand,
  parseHuddleMode,
  parseHuddleSnapshot,
  parseJoinRequest,
} from '../huddle-protocol'

const area = { x: 0, y: 25, width: 1440, height: 875 }

describe('parseJoinRequest', () => {
  test('accepts a call and keeps only known fields', () => {
    expect(parseJoinRequest({ conversationId: 'c1', workspaceId: 'w1', label: '#design', kind: 'channel', startMuted: true, extra: 1 })).toEqual({
      conversationId: 'c1',
      workspaceId: 'w1',
      label: '#design',
      kind: 'channel',
      startMuted: true,
    })
  })

  test('rejects missing or oversized ids and non-objects', () => {
    expect(parseJoinRequest(null)).toBeNull()
    expect(parseJoinRequest('x')).toBeNull()
    expect(parseJoinRequest({ workspaceId: 'w1' })).toBeNull()
    expect(parseJoinRequest({ conversationId: 'x'.repeat(501), workspaceId: 'w1' })).toBeNull()
  })

  test('defaults label and kind', () => {
    expect(parseJoinRequest({ conversationId: 'c1', workspaceId: 'w1' })).toEqual({ conversationId: 'c1', workspaceId: 'w1', label: '', kind: null })
  })
})

describe('parseHuddleCommand', () => {
  test('accepts every command', () => {
    const commands = [
      { type: 'leave' },
      { type: 'resume-playback' },
      { type: 'mute', muted: true },
      { type: 'camera', on: false },
      { type: 'screen', on: true },
      { type: 'hand', raised: true },
      { type: 'reaction', emoji: '🎉' },
      { type: 'view', view: 'pill' },
      { type: 'layout', layout: 'speaker' },
      { type: 'pin', userId: 'u1' },
      { type: 'pin', userId: null },
    ]
    for (const command of commands) expect(parseHuddleCommand(command)).toEqual(command)
  })

  test('rejects malformed commands', () => {
    for (const bad of [
      null,
      42,
      {},
      { type: 'nope' },
      { type: 'mute' },
      { type: 'mute', muted: 'yes' },
      { type: 'reaction', emoji: '' },
      { type: 'reaction', emoji: 'x'.repeat(40) },
      { type: 'view', view: 'huge' },
      { type: 'layout', layout: 'stack' },
      { type: 'pin', userId: '' },
      { type: 'pin' },
    ]) {
      expect(parseHuddleCommand(bad)).toBeNull()
    }
  })
})

describe('parseHuddleMode / parseHuddleSnapshot', () => {
  test('mode is expanded or mini', () => {
    expect(parseHuddleMode('expanded')).toBe('expanded')
    expect(parseHuddleMode('mini')).toBe('mini')
    expect(parseHuddleMode('pill')).toBeNull()
  })

  test('snapshots must be small plain objects', () => {
    expect(parseHuddleSnapshot({ status: 'connected' })).toEqual({ status: 'connected' })
    expect(parseHuddleSnapshot([])).toBeNull()
    expect(parseHuddleSnapshot(null)).toBeNull()
    expect(parseHuddleSnapshot({ blob: 'x'.repeat(300_000) })).toBeNull()
  })
})

describe('huddleBounds', () => {
  test('the mini card tucks into the bottom-right corner', () => {
    const b = huddleBounds('mini', area)
    expect(b.width).toBe(HUDDLE_MINI_SIZE.width)
    expect(b.x + b.width).toBe(area.x + area.width - 16)
    expect(b.y + b.height).toBe(area.y + area.height - 16)
  })

  test('the mini card keeps its corner when the window was moved', () => {
    const moved = { x: 20, y: 60, width: 500, height: 400 }
    const b = huddleBounds('mini', area, moved)
    expect(b.x + b.width).toBe(moved.x + moved.width)
    expect(b.y + b.height).toBe(moved.y + moved.height)
  })

  test('the expanded panel is centered', () => {
    const b = huddleBounds('expanded', area)
    expect(b.width).toBe(HUDDLE_EXPANDED_SIZE.width)
    expect(b.x).toBe(Math.round((area.width - b.width) / 2))
  })

  test('small screens shrink the window and keep it on screen', () => {
    const small = { x: 0, y: 0, width: 400, height: 300 }
    const b = huddleBounds('expanded', small)
    expect(b.width).toBe(368)
    expect(b.height).toBe(268)
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(small.width)
  })

  test('clampToArea pulls a window back inside', () => {
    expect(clampToArea({ x: -50, y: 2000, width: 100, height: 100 }, area)).toEqual({ x: 0, y: area.y + area.height - 100, width: 100, height: 100 })
  })
})
