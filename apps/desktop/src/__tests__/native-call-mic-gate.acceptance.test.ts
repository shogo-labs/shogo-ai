// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-117 acceptance: a native Zoom / Teams / Webex **call** is what gets
 * detected, not the app being open, and releasing the mic ends it — which is
 * the only thing `recording.ts` needs in order to auto-stop.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { MeetingDetector, type MicUser } from '../detection/meeting-detector'

type Entry = { pid: number; name: string; cmd?: string }

const ZOOM_APP: Entry = { pid: 51400, name: 'zoom.us', cmd: '/Applications/zoom.us.app/Contents/MacOS/zoom.us' }
const ZOOM_CAPHOST: Entry = {
  pid: 51412,
  name: 'caphost',
  cmd: '/Applications/zoom.us.app/Contents/Frameworks/caphost.app/Contents/MacOS/caphost -pid 51400',
}
const TEAMS_APP: Entry = { pid: 700, name: 'Microsoft Teams', cmd: '/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams' }
const WEBEX_APP: Entry = { pid: 800, name: 'Webex', cmd: '/Applications/Cisco Webex Meetings.app/Contents/MacOS/Webex' }
const QUICKTIME: Entry = { pid: 900, name: 'QuickTime Player', cmd: '/System/Applications/QuickTime Player.app/Contents/MacOS/QuickTime Player' }

function harness(processes: Entry[], initialMic: MicUser[] | null, platform: NodeJS.Platform = 'darwin') {
  const state: { mic: MicUser[] | null } = { mic: initialMic }
  const detector = new MeetingDetector({
    platform,
    processPollIntervalMs: 15,
    listProcesses: async () => processes,
    listMicUsers: async () => state.mic,
  })
  const detected: string[] = []
  const ended: string[] = []
  detector.on('meeting-detected', (e: { app: string }) => detected.push(e.app))
  detector.on('meeting-ended', (e: { app: string }) => ended.push(e.app))
  return {
    detected,
    ended,
    tick: () => (detector as unknown as { tickProcesses(): Promise<void> }).tickProcesses(),
    setMic: (mic: MicUser[] | null) => { state.mic = mic },
    detector,
  }
}

describe('SHO-117 — the mic, not the process, decides a native call', () => {
  test('every meeting app open with no call is a quiet desktop', async () => {
    const { detected, ended, tick } = harness([ZOOM_APP, ZOOM_CAPHOST, TEAMS_APP, WEBEX_APP], [])
    await tick()
    expect(detected).toEqual([])
    expect(ended).toEqual([])
  })

  test('the mic gate is per app: Zoom on a call does not make idle Teams a meeting', async () => {
    const { detected, ended, tick, setMic } = harness([ZOOM_APP, TEAMS_APP, WEBEX_APP], [
      { pid: 51400, bundleId: 'us.zoom.xos' },
    ])
    await tick()
    expect(detected).toEqual(['Zoom'])

    // A different app holding the mic later must not keep Zoom alive, nor
    // announce Teams.
    setMic([{ pid: 700, bundleId: 'com.microsoft.teams2' }])
    await tick()
    expect(detected).toEqual(['Zoom', 'Microsoft Teams'])
    expect(ended).toEqual(['Zoom'])
  })

  test('an unrelated app holding the mic is not a meeting', async () => {
    const { detected, tick } = harness([ZOOM_APP, QUICKTIME], [{ pid: 900, bundleId: 'com.apple.QuickTimePlayerX' }])
    await tick()
    expect(detected).toEqual([])
  })

  test('two concurrent calls end independently', async () => {
    const { detected, ended, tick, setMic } = harness([ZOOM_APP, TEAMS_APP], [
      { pid: 51400, bundleId: 'us.zoom.xos' },
      { pid: 700, bundleId: 'com.microsoft.teams2' },
    ])
    await tick()
    expect(detected.sort()).toEqual(['Microsoft Teams', 'Zoom'])

    setMic([{ pid: 700, bundleId: 'com.microsoft.teams2' }])
    await tick()
    expect(ended).toEqual(['Zoom'])

    setMic([])
    await tick()
    expect(ended.sort()).toEqual(['Microsoft Teams', 'Zoom'])
    expect(detected).toHaveLength(2)
  })

  test('join → hang up → join again announces exactly one start and one end per cycle', async () => {
    const { detected, ended, tick, setMic } = harness([ZOOM_APP, ZOOM_CAPHOST], [])
    await tick()
    for (let cycle = 0; cycle < 3; cycle += 1) {
      setMic([{ pid: 51412, bundleId: 'us.zoom.caphost' }])
      await tick()
      await tick()
      setMic([])
      await tick()
      await tick()
    }
    expect(detected).toEqual(['Zoom', 'Zoom', 'Zoom'])
    expect(ended).toEqual(['Zoom', 'Zoom', 'Zoom'])
  })

  test('hanging up fires meeting-ended on the next poll, not only on a manual tick', async () => {
    const { detected, ended, setMic, detector } = harness([ZOOM_APP], [{ pid: 51400, bundleId: 'us.zoom.xos' }])
    detector.start()
    try {
      await new Promise((r) => setTimeout(r, 60))
      expect(detected).toEqual(['Zoom'])
      setMic([])
      await new Promise((r) => setTimeout(r, 120))
      expect(ended).toEqual(['Zoom'])
    } finally {
      detector.stop()
    }
  })

  test('Zoom quitting mid-call still ends the call, even with a stale mic list', async () => {
    const processes: Entry[] = [ZOOM_APP, ZOOM_CAPHOST]
    const state = { mic: [{ pid: 51400, bundleId: 'us.zoom.xos' }] as MicUser[] | null }
    const detector = new MeetingDetector({ platform: 'darwin', listProcesses: async () => processes, listMicUsers: async () => state.mic })
    const detected: string[] = []
    const ended: string[] = []
    detector.on('meeting-detected', (e: { app: string }) => detected.push(e.app))
    detector.on('meeting-ended', (e: { app: string }) => ended.push(e.app))
    const tick = () => (detector as unknown as { tickProcesses(): Promise<void> }).tickProcesses()

    await tick()
    expect(detected).toEqual(['Zoom'])
    // The app goes away (quit / update) while the mic query still reports the
    // capture helper from the previous poll.
    processes.length = 0
    await tick()
    expect(ended).toEqual(['Zoom'])
  })

  test('a mic poll that fails while idle still announces the call (process fallback)', async () => {
    const { detected, tick } = harness([ZOOM_APP], null)
    await tick()
    expect(detected).toEqual(['Zoom'])
  })

  test('a mic poll that fails mid-call neither ends the call nor forgets it', async () => {
    const { detected, ended, tick, setMic } = harness([ZOOM_APP], [{ pid: 51400, bundleId: 'us.zoom.xos' }])
    await tick()
    setMic(null)
    await tick()
    await tick()
    expect(ended).toEqual([])
    expect(detected).toEqual(['Zoom'])
  })

  test('a browser call is still detected while Zoom sits open and idle', async () => {
    const { detected, tick } = harness([ZOOM_APP, { pid: 20, name: 'Google Chrome', cmd: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }], [
      { pid: 21, bundleId: 'com.google.Chrome.helper' },
    ])
    await tick()
    expect(detected).toEqual(['Google Chrome'])
  })

  test('off macOS nothing changes: the process heuristic still decides', async () => {
    const { detected, ended, tick } = harness([ZOOM_APP, TEAMS_APP], [], 'win32')
    await tick()
    expect(detected.sort()).toEqual(['Microsoft Teams', 'Zoom'])
    expect(ended).toEqual([])
  })

  test('the bundle prefix is scoped to the vendor, case-insensitively', async () => {
    const unrelated = harness([ZOOM_APP], [{ pid: 999, bundleId: 'us.zoomclone.app' }])
    await unrelated.tick()
    expect(unrelated.detected).toEqual([])

    const upper = harness([ZOOM_APP], [{ pid: 998, bundleId: 'US.ZOOM.xos' }])
    await upper.tick()
    expect(upper.detected).toEqual(['Zoom'])
  })
})

describe('SHO-117 — meeting-ended is what recording.ts auto-stops on', () => {
  const recordingSrc = fs.readFileSync(path.join(__dirname, '..', 'recording.ts'), 'utf8')

  test('the detector event is wired to the auto-stop grace timer', () => {
    expect(recordingSrc).toMatch(/detector\.on\('meeting-ended'[\s\S]{0,400}onMeetingMaybeEnded\(\)/)
  })

  test('the grace timer stops the capture and notifies, once per ended event', () => {
    const fn = recordingSrc.slice(recordingSrc.indexOf('function onMeetingMaybeEnded'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain('gracePeriodSeconds')
    expect(body).toContain('Auto-stopping: meeting ended')
    expect(body).toContain('stopMeetingCapture()')
    expect(body).toContain("showNotification('Meeting ended', 'Recording stopped automatically.')")
  })

  test('a missing or broken mic-users helper resolves to null, never to "nobody has the mic"', () => {
    expect(recordingSrc).toMatch(/if \(!binary\) return Promise\.resolve\(null\)/)
    expect(recordingSrc).toMatch(/async function listMicUsers\(\): Promise<MicUser\[\] \| null>/)
  })
})
