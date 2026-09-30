// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { MeetingDetector, type MicUser, type WindowTitle } from '../detection/meeting-detector'

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

describe('browser call detection', () => {
  const chromeHelper = {
    pid: 20,
    name: '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper',
    cmd: 'Google Chrome Helper --type=utility --utility-sub-type=audio.mojom.AudioService',
  }

  async function detectBrowser(micUsers: MicUser[], titles: WindowTitle[]) {
    const detector = new MeetingDetector({
      platform: 'darwin',
      listProcesses: async () => [chromeHelper],
      listMicUsers: async () => micUsers,
      listWindowTitles: async () => titles,
    })
    const detected: string[] = []
    const ended: string[] = []
    detector.on('meeting-detected', (evt: { app: string }) => detected.push(evt.app))
    detector.on('meeting-ended', (evt: { app: string }) => ended.push(evt.app))
    const tick = () => (detector as unknown as { tickProcesses(): Promise<void> }).tickProcesses()
    return { detector, detected, ended, tick }
  }

  test('names a Meet call from the browser tab title', async () => {
    const { detected, tick } = await detectBrowser(
      [{ pid: 20, bundleId: 'com.google.Chrome.helper' }],
      [
        { owner: 'Google Chrome', title: 'Inbox' },
        { owner: 'Google Chrome', title: 'Meet - urp-zxdq-rqd' },
      ],
    )
    await tick()
    expect(detected).toEqual(['Google Meet'])
  })

  test('falls back to the browser name when no meeting tab is visible', async () => {
    const { detected, tick } = await detectBrowser([{ pid: 20, bundleId: 'com.google.Chrome.helper' }], [])
    await tick()
    expect(detected).toEqual(['Google Chrome'])
  })

  test('ignores Chrome playing audio without the mic', async () => {
    const { detected, tick } = await detectBrowser([], [{ owner: 'Google Chrome', title: 'Meet - abc' }])
    await tick()
    expect(detected).toEqual([])
  })

  test('ends the call under the same name once the mic is released', async () => {
    const micUsers: MicUser[] = [{ pid: 20, bundleId: 'com.google.Chrome.helper' }]
    const { detected, ended, tick } = await detectBrowser(micUsers, [{ owner: 'Google Chrome', title: 'Meet - abc' }])
    await tick()
    micUsers.length = 0
    await tick()
    expect(detected).toEqual(['Google Meet'])
    expect(ended).toEqual(['Google Meet'])
  })
})
