// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Project-wide IDE drawer host.
 *
 * `DrawerHost` is the lifted-out version of the bottom-drawer that used
 * to live inside `Workbench.tsx`. It mounts the `BottomPanel` once at
 * the project layout level so the drawer survives previewTab changes
 * (Canvas → IDE → Files cycles no longer drop the user's terminal
 * sessions or runtime-log buffer).
 *
 * The component is intentionally self-contained:
 *   - State (open / size / activeTab) lives in `ideBottomPanelStore`
 *     so the same drawer is visible to both Workbench's ⌘J keybind and
 *     the project-layout mount.
 *   - Layout uses a flex-column wrapper so the drawer eats height from
 *     the bottom, and the `children` (the previewTab switch) fills the
 *     rest.
 *   - Gates (`platformIsWeb`, `canvasAreaHidden`, `isChatFullscreen`)
 *     are explicit props rather than read from a router/platform module,
 *     so the component is unit-testable without booting `expo-router`
 *     or stubbing `react-native`'s `Platform`.
 */

import { useCallback, useEffect, useRef } from 'react'
import {
  ideBottomPanelStore,
  useBottomPanelState,
} from '../../../../lib/ide-bottom-panel-store'
import {
  getEntries,
  subscribe as subscribeRuntimeLogs,
} from '../../../../lib/runtime-logs/runtime-log-store'
import { BottomPanel } from './BottomPanel'

const SIZE_MIN = 120
const SIZE_MAX = 800
const PEEK_CLICK_SLOP = 6

interface DrawerHostProps {
  projectId: string | null | undefined
  /** Where the agent runtime lives — passed through to Output tab. */
  agentUrl?: string | null
  /** Chat messages (for exec-entry merge). */
  messages?: any[]
  /** Reveal a file at (line, col) — wired by Workbench when present. */
  onReveal?: (path: string, line: number, column: number) => void
  /** True on web (we're a web-only feature for now). */
  platformIsWeb: boolean
  /**
   * The right pane is hidden (e.g. narrow chat-only mode). Drawer must
   * not render — its children would float over the chat.
   */
  canvasAreaHidden: boolean
  /**
   * `previewTab === 'chat-fullscreen'` — the canvas view is replaced by
   * a full-bleed chat. The drawer would steal vertical space we want
   * the chat to use.
   */
  isChatFullscreen: boolean
  /** The right-pane content (the previewTab switch). */
  children: React.ReactNode
}

/**
 * The drawer is gated to web + non-hidden canvas + non-fullscreen chat.
 * Exported pure so the test suite can assert the boolean without
 * mounting the component.
 */
export function shouldShowDrawer(args: {
  platformIsWeb: boolean
  canvasAreaHidden: boolean
  isChatFullscreen: boolean
}): boolean {
  return (
    args.platformIsWeb && !args.canvasAreaHidden && !args.isChatFullscreen
  )
}

export function DrawerHost({
  projectId,
  agentUrl,
  messages,
  onReveal,
  platformIsWeb,
  canvasAreaHidden,
  isChatFullscreen,
  children,
}: DrawerHostProps): JSX.Element {
  const open = useBottomPanelState((s) => s.open)
  const size = useBottomPanelState((s) => s.size)
  const newSessionNonce = useBottomPanelState((s) => s.newTerminalNonce)

  const showDrawer = shouldShowDrawer({
    platformIsWeb,
    canvasAreaHidden,
    isChatFullscreen,
  })

  // Bridge: when a new error entry lands in the runtime-log store for
  // *this* project, notify the ide-bottom-panel store so it can:
  //   - bump `unseenErrorsByProject[projectId]` (drives the red dot on
  //     the Output tab),
  //   - and on the *first* error per project session, auto-open the
  //     drawer with `activeTab = 'Output'`.
  //
  // We track the last-seen sequence number so re-renders / store
  // restoration after `clearProject` don't re-fire `reportError` for
  // already-seen entries.
  const lastReportedSeqRef = useRef<number>(-Infinity)
  useEffect(() => {
    if (!projectId) return
    // Initialize the cursor so we don't re-report entries that landed
    // before this DrawerHost mounted (e.g. from the snapshot replay).
    const initial = getEntries(projectId)
    for (const e of initial) {
      if (e.seq > lastReportedSeqRef.current) lastReportedSeqRef.current = e.seq
    }
    return subscribeRuntimeLogs(projectId, () => {
      const next = getEntries(projectId)
      let highestSeen = lastReportedSeqRef.current
      for (const entry of next) {
        if (entry.seq <= lastReportedSeqRef.current) continue
        if (entry.seq > highestSeen) highestSeen = entry.seq
        if (entry.level === 'error') {
          ideBottomPanelStore.reportError(projectId)
        }
      }
      lastReportedSeqRef.current = highestSeen
    })
  }, [projectId])

  const handleResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const startY = e.clientY
      const startSize = ideBottomPanelStore.getState().size
      const move = (ev: MouseEvent): void => {
        const delta = startY - ev.clientY
        ideBottomPanelStore.setSize(
          Math.min(SIZE_MAX, Math.max(SIZE_MIN, startSize + delta)),
        )
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      e.preventDefault()
    },
    [],
  )

  const handlePeekDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const startY = e.clientY
      let lastSize: number | null = null
      let moved = false
      const move = (ev: MouseEvent): void => {
        const delta = startY - ev.clientY
        if (!moved && Math.abs(delta) < PEEK_CLICK_SLOP) return
        moved = true
        lastSize = Math.min(SIZE_MAX, Math.max(SIZE_MIN, delta))
        ideBottomPanelStore.setSize(lastSize)
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        if (moved && lastSize != null) {
          ideBottomPanelStore.setSize(lastSize)
        }
        ideBottomPanelStore.setOpen(true)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [],
  )

  if (!showDrawer) {
    // Gates failing — render children unchanged so the right pane keeps
    // working exactly like it did pre-refactor on native / chat-only.
    return <>{children}</>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex-1 min-h-0">{children}</div>
      {open ? (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize panel"
            className="h-[3px] shrink-0 cursor-row-resize bg-transparent hover:bg-[#0078d4]/60"
            onMouseDown={handleResizeStart}
            onDoubleClick={() => ideBottomPanelStore.setSize(260)}
          />
          <div
            data-testid="drawer-host-panel"
            style={{ height: size, flexShrink: 0 }}
            className="min-h-0"
          >
            <BottomPanel
              projectId={projectId ?? null}
              newSessionNonce={newSessionNonce}
              onClose={() => ideBottomPanelStore.setOpen(false)}
              onReveal={onReveal}
              agentUrl={agentUrl ?? null}
              messages={messages}
            />
          </div>
        </>
      ) : (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Drag up to open panel"
          title="Drag up to open panel  (⌘J)"
          data-testid="drawer-host-peek"
          className="group relative h-[3px] shrink-0 cursor-row-resize select-none"
          onMouseDown={handlePeekDown}
        >
          <div
            aria-hidden
            className="absolute inset-x-0 -top-[4px] bottom-0 transition-colors group-hover:bg-[#0078d4]/60"
          />
        </div>
      )}
    </div>
  )
}
