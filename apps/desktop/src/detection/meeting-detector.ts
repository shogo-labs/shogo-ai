// SPDX-License-Identifier: MIT
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
  /** Processes currently capturing from the mic, or null when the OS can't
   *  tell us. macOS uses this to confirm apps that idle with call helpers. */
  listMicUsers?: () => Promise<MicUser[] | null>
  /** On-screen window titles, used to name browser calls ("Meet - …"). */
  listWindowTitles?: () => Promise<WindowTitle[]>
}

export interface MicUser {
  pid: number
  bundleId: string
}

export interface WindowTitle {
  owner: string
  title: string
}

interface DetectionContext {
  platform: NodeJS.Platform
  micUsers: MicUser[] | null
}

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------

interface AppMatcher {
  id: string
  label: string
  test: (entry: PsListEntry, ctx: DetectionContext) => boolean
}

const SLACK_BUNDLE_ID = /^com\.tinyspeck\.slackmacgap(\.|$)/

function isSlackHuddle(entry: PsListEntry, ctx: DetectionContext): boolean {
  if (!/Slack/.test(entry.name)) return false
  // Slack keeps its WebRTC/audio helpers alive between huddles, so on macOS
  // only a Slack process holding the mic counts as a live huddle.
  if (ctx.platform === 'darwin') {
    return ctx.micUsers?.some((user) => user.pid === entry.pid || SLACK_BUNDLE_ID.test(user.bundleId)) ?? false
  }
  return /huddle|AudioHelper|WebRTC/i.test(entry.cmd ?? '')
}

interface BrowserInfo {
  name: string
  bundleId: RegExp
  owner: RegExp
}

const BROWSERS: BrowserInfo[] = [
  { name: 'Google Chrome', bundleId: /^com\.google\.Chrome/, owner: /^Google Chrome/ },
  { name: 'Microsoft Edge', bundleId: /^com\.microsoft\.edgemac/, owner: /^Microsoft Edge/ },
  { name: 'Arc', bundleId: /^company\.thebrowser\.Browser/, owner: /^Arc$/ },
  { name: 'Dia', bundleId: /^company\.thebrowser\.dia/, owner: /^Dia$/ },
  { name: 'Brave', bundleId: /^com\.brave\.Browser/, owner: /^Brave/ },
  { name: 'Vivaldi', bundleId: /^com\.vivaldi\.Vivaldi/, owner: /^Vivaldi/ },
  { name: 'Firefox', bundleId: /^org\.mozilla\.firefox/, owner: /^Firefox/ },
  { name: 'Safari', bundleId: /^com\.apple\.(Safari|WebKit)/, owner: /^Safari/ },
]

/** Tab titles of web meeting apps, matched against the browser's windows. */
const WEB_MEETINGS: Array<{ label: string; title: RegExp }> = [
  { label: 'Google Meet', title: /^Meet\s[-–]|Google Meet|meet\.google\.com/i },
  { label: 'Microsoft Teams', title: /Microsoft Teams|\|\s*Teams\b/i },
  { label: 'Zoom', title: /Zoom (Meeting|Webinar)|zoom\.us/i },
  { label: 'Webex', title: /Webex/i },
  { label: 'Slack Huddle', title: /Huddle/i },
]

function browserForBundle(bundleId: string): BrowserInfo | undefined {
  return BROWSERS.find((browser) => browser.bundleId.test(bundleId))
}

/** Names a browser call from its window titles, falling back to the browser
 * when no known meeting tab is visible (or titles aren't readable). */
function browserCallLabel(browser: BrowserInfo, titles: WindowTitle[]): string {
  const own = titles.filter((window) => browser.owner.test(window.owner))
  for (const meeting of WEB_MEETINGS) {
    if (own.some((window) => meeting.title.test(window.title))) return meeting.label
  }
  return browser.name
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
    test: isSlackHuddle,
  },
  {
    id: 'google-meet',
    label: 'Google Meet',
    // Weak process heuristic for platforms without per-process mic state.
    // Chrome's audio service runs for any playback, so macOS uses browser
    // mic usage instead (see `detectBrowserCall`).
    test: (e, ctx) =>
      ctx.platform !== 'darwin' &&
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
  /** Apps we've announced as active, id → label. Used to avoid spamming
   *  events and to end a call under the label it was announced with. */
  private readonly activeApps = new Map<string, string>()
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
      listMicUsers: opts.listMicUsers,
      listWindowTitles: opts.listWindowTitles,
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

    let micUsers: MicUser[] | null = null
    if (this.opts.listMicUsers) {
      try {
        micUsers = await this.opts.listMicUsers()
      } catch (err) {
        this.emit('warning', { message: `mic poll failed: ${(err as Error).message}` } satisfies WarningEvent)
      }
    }
    const ctx: DetectionContext = { platform: this.opts.platform ?? process.platform, micUsers }

    const hitsByApp = new Map<string, { pid: number; label: string }>()
    for (const entry of entries) {
      for (const matcher of MEETING_APPS) {
        if (matcher.test(entry, ctx) && !hitsByApp.has(matcher.id)) {
          hitsByApp.set(matcher.id, { pid: entry.pid, label: matcher.label })
        }
      }
    }
    const browserCall = await this.detectBrowserCall(ctx)
    if (browserCall) hitsByApp.set(browserCall.id, browserCall)

    // Announce newly active apps.
    for (const [id, hit] of hitsByApp) {
      if (!this.activeApps.has(id)) {
        this.activeApps.set(id, hit.label)
        this.emit('meeting-detected', { source: 'process', app: hit.label, pid: hit.pid } satisfies MeetingDetectedEvent)
      }
    }

    // Announce ended apps (no longer visible).
    for (const [id, label] of Array.from(this.activeApps)) {
      if (!hitsByApp.has(id)) {
        this.activeApps.delete(id)
        this.emit('meeting-ended', { source: 'process', app: label } satisfies MeetingEndedEvent)
      }
    }
  }

  /** macOS: a browser holding the mic is a web call (Meet, Teams, Zoom web…). */
  private async detectBrowserCall(ctx: DetectionContext): Promise<{ id: string; pid: number; label: string } | null> {
    if (ctx.platform !== 'darwin' || !ctx.micUsers) return null
    for (const user of ctx.micUsers) {
      const browser = browserForBundle(user.bundleId)
      if (!browser) continue
      const id = `browser:${browser.name}`
      const known = this.activeApps.get(id)
      if (known) return { id, pid: user.pid, label: known }
      let titles: WindowTitle[] = []
      try {
        titles = (await this.opts.listWindowTitles?.()) ?? []
      } catch (err) {
        this.emit('warning', { message: `window title poll failed: ${(err as Error).message}` } satisfies WarningEvent)
      }
      return { id, pid: user.pid, label: browserCallLabel(browser, titles) }
    }
    return null
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
