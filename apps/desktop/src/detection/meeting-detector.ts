// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-platform meeting detection in pure Node.
 *
 * Replaces the Swift `MicMonitor` + `CalendarMonitor` from the deleted
 * `shogo-audio` helper with two independent polling loops:
 *
 * 1. **Process watcher (ps-list)** — looks for Zoom, Teams, Webex, Slack
 *    Huddle renderer processes. Chrome/Edge with a Meet/Teams tab are
 *    harder to detect reliably without AppleScript; we include a best-effort
 *    match on window titles via `ps` output only (CLI `comm` column).
 * 2. **Calendar watcher (node-ical)** — on macOS, walks
 *    `~/Library/Calendars/*.caldav/.../Events/*.ics` every 5 minutes and
 *    emits `upcoming-meeting` for any event starting in the next 5 minutes
 *    that has a conference link. Windows calendar parsing is skipped in
 *    v1 (documented gap).
 *
 * The detector is an event emitter so callers can subscribe without
 * pulling Electron into this module. `recording.ts` wires it up to the
 * renderer event channels the UI already listens to.
 */
import { EventEmitter } from 'events'
import os from 'os'
import path from 'path'
import fs from 'fs'

// `ps-list` is an ES module in its latest version; we import it dynamically
// from the CommonJS compiled output to avoid an esm/cjs interop headache.
type PsListEntry = { pid: number; name: string; cmd?: string }
type PsListFn = () => Promise<PsListEntry[]>
let cachedPsList: PsListFn | null = null
async function loadPsList(): Promise<PsListFn> {
  if (cachedPsList) return cachedPsList
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<{ default: PsListFn }>
  const mod = await dynamicImport('ps-list')
  cachedPsList = mod.default
  return cachedPsList
}

// node-ical is CommonJS already; require it lazily so the module isn't
// touched on platforms/tests that don't need it.
type IcalEvent = {
  type?: string
  summary?: string
  start?: Date
  end?: Date
  location?: string
  description?: string
  url?: string
}
type IcalModule = { sync: { parseFile: (path: string) => Record<string, IcalEvent> } }
let cachedIcal: IcalModule | null = null
function loadIcal(): IcalModule | null {
  if (cachedIcal) return cachedIcal
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedIcal = require('node-ical') as IcalModule
    return cachedIcal
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DetectorEventName =
  | 'meeting-detected'
  | 'meeting-ended'
  | 'upcoming-meeting'
  | 'warning'

export interface MeetingDetectedEvent {
  source: 'process'
  app: string
  pid: number
}

export interface MeetingEndedEvent {
  source: 'process'
  app: string
}

export interface UpcomingMeetingEvent {
  title: string
  start: number // epoch ms
  minutesUntilStart: number
  hasConferenceLink: boolean
  location?: string
}

export interface WarningEvent {
  message: string
}

export interface MeetingDetectorOptions {
  platform?: NodeJS.Platform
  processPollIntervalMs?: number
  calendarPollIntervalMs?: number
  /** Pre-set ICS paths. If omitted, the detector scans the default OS
   *  location. Mostly useful for tests. */
  icsPaths?: string[] | null
  /** Hook the process-list implementation — tests inject a stub. */
  listProcesses?: () => Promise<PsListEntry[]>
  /** Hook filesystem scanning — tests inject fake ICS paths. */
  scanIcs?: () => string[]
}

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------

interface AppMatcher {
  id: string
  label: string
  test: (entry: PsListEntry) => boolean
}

const MEETING_APPS: AppMatcher[] = [
  {
    id: 'zoom',
    label: 'Zoom',
    // Covers both packaged ("zoom.us") and the legacy CFBundle name ("Zoom").
    test: (e) => /^zoom(\.us)?$/i.test(e.name) || /CptHost/.test(e.name),
  },
  {
    id: 'teams',
    label: 'Microsoft Teams',
    test: (e) => /^(Microsoft Teams|Teams|Teams Helper|ms-teams)$/i.test(e.name),
  },
  {
    id: 'webex',
    label: 'Webex',
    test: (e) => /(Webex|Cisco Webex)/i.test(e.name),
  },
  {
    id: 'slack-huddle',
    label: 'Slack Huddle',
    // Slack runs many helper processes; huddles spawn an extra audio one on
    // Mac. We match the name and cmdline heuristically.
    test: (e) =>
      /Slack/.test(e.name) && /huddle|AudioHelper|WebRTC/i.test(e.cmd ?? ''),
  },
  {
    id: 'google-meet',
    label: 'Google Meet',
    // We can only see renderer process names here; Chrome renderers have
    // `--utility-sub-type=audio.mojom.AudioService` (or similar) when a page
    // is using the mic. We treat the presence of such a renderer + a Chrome
    // process as a weak signal and report it as "meet-like". UI treats it
    // the same as any other detection.
    test: (e) =>
      /^(Google Chrome|Chromium|Microsoft Edge)/i.test(e.name) &&
      /audio\.mojom|meet\.google\.com|teams\.microsoft\.com/i.test(e.cmd ?? ''),
  },
]

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_PROCESS_POLL_MS = 5_000
const DEFAULT_CALENDAR_POLL_MS = 5 * 60_000
const UPCOMING_WINDOW_MS = 5 * 60_000

export class MeetingDetector extends EventEmitter {
  private readonly opts: Required<Pick<MeetingDetectorOptions, 'processPollIntervalMs' | 'calendarPollIntervalMs'>> & MeetingDetectorOptions
  private processTimer: NodeJS.Timeout | null = null
  private calendarTimer: NodeJS.Timeout | null = null
  /** Apps we've announced as active. Used to avoid spamming events. */
  private readonly activeApps = new Set<string>()
  /** Upcoming events we've already announced, keyed by uid+start. */
  private readonly announcedEvents = new Set<string>()

  constructor(opts: MeetingDetectorOptions = {}) {
    super()
    this.opts = {
      platform: opts.platform ?? process.platform,
      processPollIntervalMs: opts.processPollIntervalMs ?? DEFAULT_PROCESS_POLL_MS,
      calendarPollIntervalMs: opts.calendarPollIntervalMs ?? DEFAULT_CALENDAR_POLL_MS,
      icsPaths: opts.icsPaths ?? null,
      listProcesses: opts.listProcesses,
      scanIcs: opts.scanIcs,
    }
  }

  start(): void {
    if (this.processTimer) return
    // Kick off the first tick immediately so callers don't wait 5 s to see
    // state, then schedule interval polls.
    void this.tickProcesses()
    this.processTimer = setInterval(() => { void this.tickProcesses() }, this.opts.processPollIntervalMs)
    this.processTimer.unref?.()

    if (this.opts.platform === 'darwin') {
      void this.tickCalendar()
      this.calendarTimer = setInterval(() => { void this.tickCalendar() }, this.opts.calendarPollIntervalMs)
      this.calendarTimer.unref?.()
    }
  }

  stop(): void {
    if (this.processTimer) {
      clearInterval(this.processTimer)
      this.processTimer = null
    }
    if (this.calendarTimer) {
      clearInterval(this.calendarTimer)
      this.calendarTimer = null
    }
  }

  // ---- Process polling ----------------------------------------------------

  private async tickProcesses(): Promise<void> {
    let entries: PsListEntry[]
    try {
      if (this.opts.listProcesses) {
        entries = await this.opts.listProcesses()
      } else {
        const psList = await loadPsList()
        entries = await psList()
      }
    } catch (err) {
      this.emit('warning', { message: `process poll failed: ${(err as Error).message }` } satisfies WarningEvent)
      return
    }

    const hitsByApp = new Map<string, PsListEntry>()
    for (const entry of entries) {
      for (const matcher of MEETING_APPS) {
        if (matcher.test(entry) && !hitsByApp.has(matcher.id)) {
          hitsByApp.set(matcher.id, entry)
        }
      }
    }

    // Announce newly active apps.
    for (const [id, entry] of hitsByApp) {
      if (!this.activeApps.has(id)) {
        this.activeApps.add(id)
        const label = MEETING_APPS.find((m) => m.id === id)?.label ?? id
        this.emit('meeting-detected', { source: 'process', app: label, pid: entry.pid } satisfies MeetingDetectedEvent)
      }
    }

    // Announce ended apps (no longer visible).
    for (const id of Array.from(this.activeApps)) {
      if (!hitsByApp.has(id)) {
        this.activeApps.delete(id)
        const label = MEETING_APPS.find((m) => m.id === id)?.label ?? id
        this.emit('meeting-ended', { source: 'process', app: label } satisfies MeetingEndedEvent)
      }
    }
  }

  // ---- Calendar polling ---------------------------------------------------

  private async tickCalendar(): Promise<void> {
    const ical = loadIcal()
    if (!ical) {
      this.emit('warning', { message: 'node-ical not available — calendar polling disabled' } satisfies WarningEvent)
      return
    }

    const icsPaths = this.opts.icsPaths ?? (this.opts.scanIcs ? this.opts.scanIcs() : scanMacIcsFiles())
    if (icsPaths.length === 0) return

    const now = Date.now()
    for (const icsPath of icsPaths) {
      let events: Record<string, IcalEvent>
      try {
        events = ical.sync.parseFile(icsPath)
      } catch {
        continue
      }
      for (const [uid, event] of Object.entries(events)) {
        if (event.type !== 'VEVENT') continue
        if (!event.start) continue
        const startMs = event.start.getTime()
        const diff = startMs - now
        if (diff < 0 || diff > UPCOMING_WINDOW_MS) continue

        const key = `${uid}:${startMs}`
        if (this.announcedEvents.has(key)) continue
        this.announcedEvents.add(key)

        const hasConferenceLink = detectConferenceLink(event)
        this.emit('upcoming-meeting', {
          title: event.summary ?? 'Untitled event',
          start: startMs,
          minutesUntilStart: Math.round(diff / 60_000),
          hasConferenceLink,
          location: event.location,
        } satisfies UpcomingMeetingEvent)
      }
    }

    // Garbage-collect announced events whose start time is now in the past
    // (otherwise the set grows forever).
    for (const key of Array.from(this.announcedEvents)) {
      const parts = key.split(':')
      const ts = Number(parts[parts.length - 1])
      if (Number.isFinite(ts) && ts + UPCOMING_WINDOW_MS < now) {
        this.announcedEvents.delete(key)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectConferenceLink(event: IcalEvent): boolean {
  const hay = `${event.location ?? ''} ${event.description ?? ''} ${event.url ?? ''}`
  return /zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com/i.test(hay)
}

/**
 * Best-effort scan of macOS CalDAV-cached `.ics` files. Returns the full
 * list of absolute paths under `~/Library/Calendars/*.caldav/.../Events/`.
 *
 * Stays conservative: a bad calendar should not cause the whole detector
 * to crash, so we swallow errors per-subtree and move on.
 */
function scanMacIcsFiles(): string[] {
  const home = os.homedir()
  const base = path.join(home, 'Library', 'Calendars')
  if (!fs.existsSync(base)) return []
  const out: string[] = []

  let accountDirs: string[] = []
  try {
    accountDirs = fs.readdirSync(base).filter((n) => n.endsWith('.caldav')).map((n) => path.join(base, n))
  } catch {
    return out
  }

  for (const accountDir of accountDirs) {
    walkIcs(accountDir, out)
  }
  return out
}

function walkIcs(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkIcs(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.ics')) {
      out.push(full)
    }
  }
}

// Exposed for testability.
export const __testing = { scanMacIcsFiles, detectConferenceLink, MEETING_APPS }
