// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Picture-in-picture for the huddle on Chromium. When you switch tabs or
 * apps, the mini view moves into a small always-on-top window so you keep
 * seeing who is talking and their reactions. The window shares this page's
 * JS context, so the LiveKit video tracks attach to it directly.
 *
 * The content is plain DOM with inline styles on purpose: the window starts
 * with no stylesheets, and the app's styling and press handling belong to the
 * main document.
 */
import { createElement, useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Platform } from 'react-native'
import { useHuddleRoster } from '../../hooks/useHuddleRoster'
import { resolveAvatarUrl } from '../../lib/chat-attachment-url'
import { notesPillLabel, notesPillTone } from '../../lib/huddle-notes'
import { huddleVideoSupported, leaveHuddleCall, sendHuddleReaction, setHuddleCamera, setHuddleHand, setHuddleMuted, setHuddleNotesEnabled, setHuddleView, type HuddleCallState } from '../../lib/huddle-call'
import { cameraControl, handControl, leaveControl, micControl, quickReactionControl, type HuddleControlGlyph, type HuddleControlModel, type HuddleControlTone } from '../../lib/huddle-control-model'
import { PIP_ICONS, type PipIconName } from '../../lib/huddle-pip-icons'
import { miniFeature, miniScreen, miniSelfView, type RosterEntry } from '../../lib/huddle-roster'
import { HuddleVideo } from './HuddleVideo'

interface DocumentPictureInPicture {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>
  window: Window | null
}

function api(): DocumentPictureInPicture | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  return (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture ?? null
}

export const pipSupported = api() !== null

let pipWindow: Window | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export async function openPictureInPicture(): Promise<void> {
  const pip = api()
  if (!pip || pipWindow) return
  try {
    const win = await pip.requestWindow({ width: 340, height: 230 })
    win.document.title = 'Shogo huddle'
    win.document.body.style.margin = '0'
    win.document.body.style.background = '#0a0a0a'
    const style = win.document.createElement('style')
    style.textContent = `@keyframes huddle-float{0%{opacity:0;transform:translateY(0) scale(.6)}12%{opacity:1;transform:translateY(-10px) scale(1.15)}80%{opacity:1}100%{opacity:0;transform:translateY(-110px) scale(1)}}`
    win.document.head.appendChild(style)
    win.addEventListener('pagehide', () => {
      if (pipWindow === win) {
        pipWindow = null
        emit()
      }
    })
    pipWindow = win
    emit()
  } catch {
    // Needs a user gesture or a supported browser; the mini card stays in the page.
  }
}

export function closePictureInPicture(): void {
  const win = pipWindow
  pipWindow = null
  emit()
  try {
    win?.close()
  } catch {
    // Already closed.
  }
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function usePictureInPicture() {
  const window = useSyncExternalStore(subscribe, () => pipWindow, () => null)
  return { supported: pipSupported, window, open: openPictureInPicture, close: closePictureInPicture }
}

/**
 * Chrome's automatic picture-in-picture: the `enterpictureinpicture` media
 * session action fires when the tab is hidden during a call that uses the
 * camera or mic. Falls back to trying on `visibilitychange` (which works when
 * the browser still holds user activation).
 */
export function useAutoPictureInPicture(active: boolean): void {
  useEffect(() => {
    if (!pipSupported || !active || typeof document === 'undefined') return
    const session = (navigator as unknown as { mediaSession?: { setActionHandler: (a: string, h: (() => void) | null) => void } }).mediaSession
    try {
      session?.setActionHandler('enterpictureinpicture', () => void openPictureInPicture())
    } catch {
      // The action isn't supported in this browser.
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void openPictureInPicture()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      try {
        session?.setActionHandler('enterpictureinpicture', null)
      } catch {
        // Nothing to undo.
      }
    }
  }, [active])

  // Back in the tab: the card returns to the page.
  useEffect(() => {
    if (!pipSupported) return
    const onVisible = () => {
      if (document.visibilityState === 'visible' && pipWindow && !pipWindow.document.hasFocus()) closePictureInPicture()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
}

const btn = (bg: string): React.CSSProperties => ({
  width: 32,
  height: 32,
  borderRadius: 16,
  border: 'none',
  background: bg,
  color: '#fff',
  fontSize: 15,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
})

/**
 * The app's dark-theme tokens, spelled out because this document has no
 * stylesheets to inherit them from. `muted` and `danger` are `--color-muted`
 * and `--color-destructive`; `accent` is the emerald the in-huddle bar uses for
 * every active control.
 */
const TONE_FILL: Record<HuddleControlTone, string> = {
  muted: 'rgb(42, 42, 42)',
  accent: 'rgb(5, 150, 105)',
  danger: 'rgb(220, 38, 38)',
}

const GLYPH_STROKE: Record<HuddleControlGlyph, string> = {
  foreground: 'rgb(222, 222, 222)',
  white: '#ffffff',
  destructive: 'rgb(220, 38, 38)',
}

/** Same circle and glyph size the in-huddle bar uses in its compact form. */
const CONTROL_SIZE = 32
const GLYPH_SIZE = 15

function PipIcon({ name, color }: { name: PipIconName; color: string }) {
  return createElement(
    'svg',
    {
      width: GLYPH_SIZE,
      height: GLYPH_SIZE,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: color,
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    },
    PIP_ICONS[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs })),
  )
}

/** The floating bar's twin of `ControlButton`, driven by the shared model. */
function PipControlButton({ control, onPress, testId }: { control: HuddleControlModel; onPress: () => void; testId?: string }) {
  return createElement(
    'button',
    {
      type: 'button',
      'aria-label': control.label,
      title: control.label,
      ...(control.active === undefined ? {} : { 'aria-pressed': control.active }),
      'data-testid': testId,
      onClick: onPress,
      style: {
        width: CONTROL_SIZE,
        height: CONTROL_SIZE,
        borderRadius: CONTROL_SIZE / 2,
        border: 'none',
        padding: 0,
        background: TONE_FILL[control.tone],
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      },
    },
    <PipIcon name={control.icon} color={GLYPH_STROKE[control.glyph]} />,
  )
}

function Avatar({ entry, size }: { entry: RosterEntry; size: number }) {
  const src = resolveAvatarUrl(entry.image)
  const base: React.CSSProperties = { width: size, height: size, borderRadius: size / 2, objectFit: 'cover', flexShrink: 0 }
  return src ? (
    createElement('img', { src, alt: entry.name, style: base })
  ) : (
    <div style={{ ...base, background: '#3f3f46', color: '#e4e4e7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.45, fontWeight: 600 }}>
      {entry.name.slice(0, 1).toUpperCase()}
    </div>
  )
}

function PipView() {
  const { call, roster } = useHuddleRoster()
  const feature = miniFeature(roster, call.speaking, call.pinned)
  const screen = miniScreen(roster)
  const selfView = miniSelfView(roster, feature)
  const live = roster.filter((e) => e.status === 'in-call')
  const returnToTab = () => {
    closePictureInPicture()
    setHuddleView('expanded')
    window.focus()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif', color: '#fff' }} data-testid="huddle-pip">
      <div style={{ position: 'relative', flex: 1, minHeight: 0, background: '#18181b', overflow: 'hidden' }}>
        {screen ? (
          <HuddleVideo tile={screen} fit="contain" />
        ) : feature?.cameraOn && feature.camera ? (
          <HuddleVideo tile={feature.camera} fit="cover" />
        ) : feature ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Avatar entry={feature} size={64} />
            <span style={{ fontSize: 12, color: '#d4d4d8' }}>{feature.isLocal ? 'You' : feature.name}</span>
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a1a1aa', fontSize: 13 }}>
            {call.status === 'connected' ? 'Waiting for others…' : 'Joining…'}
          </div>
        )}
        {selfView ? (
          <div style={{ position: 'absolute', bottom: 6, right: 6, width: 96, height: 54, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,.35)', background: '#000' }} data-testid="huddle-pip-self">
            <HuddleVideo tile={selfView} fit="cover" />
          </div>
        ) : null}
        <div style={{ position: 'absolute', top: 6, left: 6, display: 'flex' }}>
          {live.slice(0, 5).map((p, i) => (
            <div
              key={p.userId}
              title={`${p.isLocal ? 'You' : p.name}${p.muted ? ' (muted)' : ''}`}
              style={{ marginLeft: i ? -8 : 0, borderRadius: '50%', border: `2px solid ${p.speaking ? '#10b981' : '#18181b'}`, opacity: p.muted ? 0.7 : 1 }}
            >
              <Avatar entry={p} size={22} />
            </div>
          ))}
        </div>
        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex' }}>
          <button
            type="button"
            aria-label={notesPillLabel(call.notes)}
            title={`${notesPillLabel(call.notes)} — click to ${call.notes.enabled ? 'turn notes off' : 'turn notes on'}`}
            onClick={() => void setHuddleNotesEnabled(!call.notes.enabled)}
            style={{
              ...btn(notesPillTone(call.notes) === 'on' ? '#065f46' : notesPillTone(call.notes) === 'off' ? '#3f3f46' : '#78350f'),
              width: 'auto',
              padding: '0 8px',
              fontSize: 10,
              fontWeight: 600,
            }}
            data-testid="huddle-pip-notes"
          >
            {notesPillLabel(call.notes)}
          </button>
        </div>
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
          {call.reactions.map((r) => (
            <div
              key={r.id}
              style={{ position: 'absolute', bottom: 8, left: `${8 + ((r.id.charCodeAt(r.id.length - 1) * 7) % 76)}%`, fontSize: 26, animation: 'huddle-float 4.2s ease-out forwards', textAlign: 'center' }}
            >
              {r.emoji}
              <div style={{ fontSize: 10, background: 'rgba(0,0,0,.6)', borderRadius: 4, padding: '0 4px' }}>{r.name}</div>
            </div>
          ))}
        </div>
      </div>
      <PipControlBar call={call} onReturn={returnToTab} />
    </div>
  )
}

/**
 * The floating bar. Exported so it can be rendered and asserted without a
 * picture-in-picture window — the window is the only part that needs a browser
 * API, and the bar is where the two surfaces have to agree.
 */
export function PipControlBar({ call, onReturn }: { call: HuddleCallState; onReturn: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', padding: 8, background: '#0a0a0a' }} data-testid="huddle-pip-controls">
      <PipControlButton control={micControl(call.muted)} onPress={() => void setHuddleMuted(!call.muted)} testId="pip-mic" />
      {huddleVideoSupported ? (
        <PipControlButton control={cameraControl(call.camera)} onPress={() => void setHuddleCamera(!call.camera)} testId="pip-camera" />
      ) : null}
      <PipControlButton control={quickReactionControl()} onPress={() => void sendHuddleReaction('👍')} testId="pip-react" />
      <PipControlButton control={handControl(call.handRaised)} onPress={() => void setHuddleHand(!call.handRaised)} testId="pip-hand" />
      <PipControlButton
        control={{ label: 'Return to the tab', tone: 'muted', icon: 'maximize2', glyph: 'foreground' }}
        onPress={onReturn}
        testId="pip-return"
      />
      <PipControlButton control={leaveControl()} onPress={() => void leaveHuddleCall()} testId="pip-leave" />
    </div>
  )
}

/** Renders the mini view into the picture-in-picture window. */
export function HuddlePip() {
  const { window: win } = usePictureInPicture()
  if (!win) return null
  return createPortal(<PipView />, win.document.body)
}
