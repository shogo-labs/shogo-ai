// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * XtermView — React wrapper for an XtermSession.
 *
 * Mounts an xterm.js terminal into a div, observes container resizes
 * (FitAddon recompute), and shows a small "reconnecting…" overlay when
 * the underlying PtyClient is not in the `open` state.
 *
 * Web-only. The IDE shell is React Native Web (Platform.OS === 'web' on
 * mobile), and xterm.js requires a real DOM. We render `null` on native
 * builds so this file stays import-safe.
 *
 * The PtyClient is owned by the parent (Terminal.tsx); we just borrow it
 * for the lifetime of this component. Unmount disposes the XtermSession
 * but NOT the PtyClient — the parent decides whether the underlying
 * shell session should outlive the React tree (for tab-detach / refresh
 * resilience).
 */

import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { XtermSession } from './xterm-session'
import { isDesktopRuntime, type PtyClientLike } from './pty-factory'
import type { PtyClientState } from './pty-client'
import { useEditorFont } from '../useEditorFont'

interface XtermViewProps {
  client: PtyClientLike
  /** Hide via display:none rather than unmount when the tab is inactive. */
  hidden?: boolean
  fontSize?: number
  fontFamily?: string
  /** Auto-focus the terminal on mount + when becoming visible. */
  autoFocus?: boolean
  projectId?: string | null
  /** Desktop PTY session id (for context bridge + persistence). */
  ptySessionId?: string | null
  onCwdChange?: (cwd: string) => void
}

/**
 * Imperative handle the parent (Terminal.tsx) uses to drive the xterm.js
 * widget without owning the xterm `Terminal` instance directly. Lets the
 * "Clear" button blank the buffer and the "stop" / focus flows refocus
 * the cursor without leaking xterm internals up through props.
 */
export interface XtermViewHandle {
  /** Blank the xterm buffer + scrollback. Does not affect the PTY shell. */
  clear: () => void
  /** Move keyboard focus into the terminal grid. */
  focus: () => void
  /** Force a re-fit (e.g. after the parent layout changes height). */
  refit: () => void
  /** Open the xterm find UI when the backing renderer supports it. */
  openFind?: () => void
  /** Open the recent-command picker when the backing renderer supports it. */
  openRecent?: () => void
  /** Scroll viewport to the previous command boundary marker. */
  scrollToPrevCommand?: () => void
  /** Scroll viewport to the next command boundary marker. */
  scrollToNextCommand?: () => void
  /** Commands typed in this session (newest first). Falls back to empty array. */
  getSentLines?: () => string[]
  /** Combined keyboard + tracker + disk history (newest first). Desktop-only. */
  getRecentCommands?: () => Array<{ command: string }>
}

export const XtermView = forwardRef<XtermViewHandle, XtermViewProps>(function XtermView({
  client,
  hidden = false,
  fontSize,
  fontFamily,
  autoFocus = true,
  projectId,
  ptySessionId,
  onCwdChange,
}, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<XtermSession | null>(null)
  const desktopHandleRef = useRef<XtermViewHandle | null>(null)
  const [DesktopSurface, setDesktopSurface] = useState<React.ComponentType<any> | null>(null)
  const [state, setState] = useState<PtyClientState>(client.state)

  // BUG-012 — Terminal.tsx doesn't have the EditorSettings prop in scope
  // (it sits outside the Workbench prop tree). Instead of threading
  // settings through a 5-level prop chain, XtermView reads the live
  // font-family from the same localStorage key the rest of the IDE
  // settings already use, subscribed via `useEditorFont`. An explicit
  // `fontFamily` PROP still wins — desktop surfaces & tests can override.
  const settingFamily = useEditorFont()
  const effectiveFamily = fontFamily ?? settingFamily

  useEffect(() => {
    if (Platform.OS !== 'web') return
    if (!isDesktopRuntime()) return
    let cancelled = false
    void import('@shogo/desktop-terminal').then((m) => {
      if (!cancelled) setDesktopSurface(() => m.ShogoTerminalSurface as React.ComponentType<any>)
    })
    return () => { cancelled = true }
  }, [])

  // Mount the xterm session once, dispose on unmount. The PtyClient is
  // owned by the parent and must NOT be disposed here.
  useEffect(() => {
    if (Platform.OS !== 'web') return
    if (isDesktopRuntime()) return
    const container = containerRef.current
    if (!container) return
    const session = new XtermSession(client, { fontSize, fontFamily: effectiveFamily })
    sessionRef.current = session
    let cancelled = false
    void session.attach(container).then(() => {
      if (cancelled) return
      if (autoFocus && !hidden) session.focus()
    })
    return () => {
      cancelled = true
      sessionRef.current = null
      session.dispose()
    }
    // We deliberately don't depend on hidden/autoFocus/font here — the
    // session lives across re-renders. BUG-012: font changes are now
    // applied live by the effect below via `session.setFont()`, NOT by
    // a teardown + remount (which would reset the scrollback).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  // BUG-012 — push font changes into the live xterm session without
  // a remount. The session preserves its scrollback / cwd / shell PID;
  // only the glyph cache is invalidated. `fontSize` is included so this
  // path also fixes any "change font size, see no change" follow-on.
  useEffect(() => {
    if (Platform.OS !== 'web') return
    if (isDesktopRuntime()) return
    sessionRef.current?.setFont(effectiveFamily, fontSize)
  }, [effectiveFamily, fontSize])

  // Refit on container size changes.
  useEffect(() => {
    if (Platform.OS !== 'web') return
    if (isDesktopRuntime()) return
    const container = containerRef.current
    const session = sessionRef.current
    if (!container) return
    const ro = new ResizeObserver(() => session?.fit())
    ro.observe(container)
    return () => ro.disconnect()
    // Re-bind when the session pointer flips on remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  // Subscribe to client state for the connection overlay.
  useEffect(() => {
    setState(client.state)
    const unsub = client.onState((s: PtyClientState) => setState(s))
    return () => unsub()
  }, [client])

  // Refocus when the tab becomes visible again.
  useEffect(() => {
    if (Platform.OS !== 'web') return
    if (isDesktopRuntime()) return
    if (!hidden && autoFocus) sessionRef.current?.focus()
  }, [hidden, autoFocus])

  useImperativeHandle(
    ref,
    () => ({
      clear: () => desktopHandleRef.current?.clear() ?? sessionRef.current?.clear(),
      focus: () => desktopHandleRef.current?.focus() ?? sessionRef.current?.focus(),
      refit: () => desktopHandleRef.current?.refit() ?? sessionRef.current?.fit(),
      openFind: () => desktopHandleRef.current?.openFind?.(),
      openRecent: () => desktopHandleRef.current?.openRecent?.(),
      scrollToPrevCommand: () => {
        desktopHandleRef.current?.scrollToPrevCommand?.()
        sessionRef.current?.scrollToPrevCommand()
      },
      scrollToNextCommand: () => {
        desktopHandleRef.current?.scrollToNextCommand?.()
        sessionRef.current?.scrollToNextCommand()
      },
      getSentLines: () => sessionRef.current?.getSentLines() ?? [],
      getRecentCommands: () => desktopHandleRef.current?.getRecentCommands?.() ?? [],
    }),
    [],
  )

  if (Platform.OS !== 'web') return null

  if (isDesktopRuntime() && DesktopSurface) {
    return (
      <DesktopSurface
        ref={desktopHandleRef}
        client={client}
        hidden={hidden}
        fontSize={fontSize}
        fontFamily={effectiveFamily}
        autoFocus={autoFocus}
        projectId={projectId}
        ptySessionId={ptySessionId}
        onCwdChange={onCwdChange}
      />
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: hidden ? 'none' : 'block',
        backgroundColor: '#1e1e1e',
      }}
    >
      <style>{`
        [data-shogo-xterm-view] .xterm-viewport {
          overflow-y: auto !important;
          scrollbar-gutter: stable;
          scrollbar-width: thin;
        }
        [data-shogo-xterm-view] .xterm-viewport::-webkit-scrollbar {
          width: 10px;
        }
        [data-shogo-xterm-view] .xterm-viewport::-webkit-scrollbar-thumb {
          background: #424242;
          border-radius: 999px;
          border: 2px solid #1e1e1e;
        }
        [data-shogo-xterm-view] .xterm-viewport::-webkit-scrollbar-track {
          background: #1e1e1e;
        }
      `}</style>
      <div
        ref={containerRef}
        data-shogo-xterm-view="true"
        // xterm.js writes its own DOM under here; padding makes the
        // terminal look like VS Code (small breathing room from the
        // panel edges).
        style={{ width: '100%', height: '100%', padding: '4px 6px', overflow: 'hidden' }}
      />
      {state !== 'open' && state !== 'idle' && (
        <ConnectionOverlay state={state} />
      )}
    </div>
  )
})

function ConnectionOverlay({ state }: { state: PtyClientState }): React.ReactElement {
  const label = state === 'connecting'
    ? 'Reconnecting…'
    : state === 'closed'
      ? 'Disconnected'
      : state === 'disposed'
        ? 'Closed'
        : ''
  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 12,
        padding: '2px 8px',
        borderRadius: 4,
        background: 'rgba(0,0,0,0.6)',
        color: '#cccccc',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 11,
        pointerEvents: 'none',
      }}
    >
      {label}
    </div>
  )
}
