// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { MeetingDetector, type MicUser } from '../detection/meeting-detector'

const idleSlack = [
  { pid: 10, name: 'Slack', cmd: '/Applications/Slack.app/Contents/MacOS/Slack' },
  {
    pid: 11,
    name: 'Slack Helper',
    cmd: 'Slack Helper --type=utility --utility-sub-type=audio.mojom.AudioService --enable-features=WebRTCPipeWireCapturer',
  },
]

async function detectOnce(
  platform: NodeJS.Platform,
  micUsers: MicUser[] | null,
): Promise<string[]> {
  const detector = new MeetingDetector({
    platform,
    listProcesses: async () => idleSlack,
    listMicUsers: async () => micUsers,
  })
  const detected: string[] = []
  detector.on('meeting-detected', (evt: { app: string }) => detected.push(evt.app))
  await (detector as unknown as { tickProcesses(): Promise<void> }).tickProcesses()
  return detected
}

describe('Slack huddle detection', () => {
  test('ignores idle Slack audio helpers on macOS', async () => {
    expect(await detectOnce('darwin', [])).toEqual([])
  })

  test('detects a huddle when Slack holds the mic on macOS', async () => {
    const micUsers = [{ pid: 11, bundleId: 'com.tinyspeck.slackmacgap.helper' }]
    expect(await detectOnce('darwin', micUsers)).toEqual(['Slack Huddle'])
  })

  test('matches a Slack process by pid when the bundle id is missing', async () => {
    expect(await detectOnce('darwin', [{ pid: 11, bundleId: '' }])).toEqual(['Slack Huddle'])
  })

  test('ignores other apps using the mic', async () => {
    expect(await detectOnce('darwin', [{ pid: 99, bundleId: 'us.zoom.xos' }])).toEqual([])
  })

  test('does not guess on macOS when mic usage is unavailable', async () => {
    expect(await detectOnce('darwin', null)).toEqual([])
  })

  test('keeps the process heuristic on other platforms', async () => {
    expect(await detectOnce('win32', null)).toEqual(['Slack Huddle'])
  })
})
