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

describe('native app calls (Zoom / Teams / Webex)', () => {
  const zoomApp = { pid: 51400, name: 'zoom.us', cmd: '/Applications/zoom.us.app/Contents/MacOS/zoom.us' }
  const zoomCaptureHelper = {
    pid: 51412,
    name: 'caphost',
    cmd: '/Applications/zoom.us.app/Contents/Frameworks/caphost.app/Contents/MacOS/caphost -pid 51400',
  }
  const teamsApp = { pid: 700, name: 'Microsoft Teams', cmd: '/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams' }
  const webexApp = {
    pid: 800,
    name: 'Webex',
    cmd: '/Applications/Cisco Webex Meetings.app/Contents/MacOS/Cisco Webex Meetings',
  }

  function harness(
    processes: Array<{ pid: number; name: string; cmd?: string }>,
    mic: MicUser[] | null,
    platform: NodeJS.Platform = 'darwin',
  ) {
    const state = { mic }
    const detector = new MeetingDetector({
      platform,
      listProcesses: async () => processes,
      listMicUsers: async () => state.mic,
    })
    const detected: string[] = []
    const ended: string[] = []
    detector.on('meeting-detected', (evt: { app: string }) => detected.push(evt.app))
    detector.on('meeting-ended', (evt: { app: string }) => ended.push(evt.app))
    const tick = () => (detector as unknown as { tickProcesses(): Promise<void> }).tickProcesses()
    return { detected, ended, tick, setMic: (next: MicUser[] | null) => { state.mic = next } }
  }

  test('an app that is merely open is not a meeting', async () => {
    const { detected, tick } = harness([zoomApp, zoomCaptureHelper], [])
    await tick()
    expect(detected).toEqual([])
  })

  test('a Zoom call is detected from the mic', async () => {
    const { detected, tick } = harness([zoomApp, zoomCaptureHelper], [{ pid: 51400, bundleId: 'us.zoom.xos' }])
    await tick()
    expect(detected).toEqual(['Zoom'])
  })

  test('hanging up ends the Zoom call', async () => {
    const { detected, ended, tick, setMic } = harness(
      [zoomApp, zoomCaptureHelper],
      [{ pid: 51400, bundleId: 'us.zoom.xos' }],
    )
    await tick()
    setMic([])
    await tick()
    expect(detected).toEqual(['Zoom'])
    expect(ended).toEqual(['Zoom'])
  })

  test('a Zoom capture helper holding the mic also counts', async () => {
    const { detected, tick } = harness([zoomApp, zoomCaptureHelper], [{ pid: 51412, bundleId: 'us.zoom.caphost' }])
    await tick()
    expect(detected).toEqual(['Zoom'])
  })

  test('matches a Zoom process by pid when the bundle id is missing', async () => {
    const { detected, tick } = harness([zoomApp, zoomCaptureHelper], [{ pid: 51400, bundleId: '' }])
    await tick()
    expect(detected).toEqual(['Zoom'])
  })

  test('a failed mic poll neither starts nor ends a Zoom call', async () => {
    const { detected, ended, tick, setMic } = harness([zoomApp, zoomCaptureHelper], [{ pid: 51400, bundleId: 'us.zoom.xos' }])
    await tick()
    setMic(null)
    await tick()
    expect(ended).toEqual([])
    expect(detected).toEqual(['Zoom'])

    setMic([])
    await tick()
    expect(ended).toEqual(['Zoom'])
  })

  test('Teams and Webex are mic-gated the same way', async () => {
    const teams = harness([teamsApp], [])
    await teams.tick()
    expect(teams.detected).toEqual([])
    teams.setMic([{ pid: 700, bundleId: 'com.microsoft.teams2' }])
    await teams.tick()
    expect(teams.detected).toEqual(['Microsoft Teams'])
    teams.setMic([])
    await teams.tick()
    expect(teams.ended).toEqual(['Microsoft Teams'])

    const webex = harness([webexApp], [])
    await webex.tick()
    expect(webex.detected).toEqual([])
    webex.setMic([{ pid: 800, bundleId: 'com.cisco.webexmeetingsapp' }])
    await webex.tick()
    expect(webex.detected).toEqual(['Webex'])
    webex.setMic([])
    await webex.tick()
    expect(webex.ended).toEqual(['Webex'])
  })

  test('keeps the process heuristic off macOS', async () => {
    const { detected, tick } = harness([zoomApp, zoomCaptureHelper], null, 'win32')
    await tick()
    expect(detected).toEqual(['Zoom'])
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
