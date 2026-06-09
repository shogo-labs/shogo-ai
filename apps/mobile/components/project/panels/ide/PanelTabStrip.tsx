// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import * as React from 'react'
import { ChevronDown, Maximize2, Minimize2, MoreHorizontal, Plus, X, Trash2, SquareSplitHorizontal, Terminal as TerminalIcon } from 'lucide-react-native'
import { SHELL_LABELS, SHELL_OPTIONS } from './terminal/useShellName'
import {
  BOTTOM_PANEL_TABS,
  type BottomPanelTab,
} from '../../../../lib/ide-bottom-panel-store'

/**
 * The tab strip that sits ABOVE the active bottom panel pane.
 *
 * Phase 11 extracted this from `BottomPanel.tsx` so the strip can be
 * tested in isolation (no Terminal / Output side-effects on mount) and
 * so the animated underline indicator has one obvious owner.
 *
 * VS Code parity details (1.95):
 *   • Typography — uppercase, 11px, font-weight 600, letter-spacing
 *     0.04em. Matches VS Code's `--vscode-panelTitle-activeForeground`
 *     stack.
 *   • Inactive label color = `#858585`, hover = `#ffffff`, active =
 *     `#ffffff`.
 *   • Underline — a SINGLE absolutely-positioned 1px bar at the bottom
 *     of the strip that slides via `transform: translateX(...)` with a
 *     200ms ease-out transition. (We *measure* button widths after mount
 *     instead of hardcoding so localization or future icon badges don't
 *     desync the bar.)
 *   • Right-side controls — `ChevronDown` "Hide panel" + `X` "Close
 *     panel" matching the existing Workbench affordances.
 *
 * The component is intentionally presentation-only. Active-tab state,
 * unseen-error badges, and shortcut binding all stay in BottomPanel.
 */
export interface PanelTabStripProps {
  activeTab: BottomPanelTab
  onSelect(tab: BottomPanelTab): void
  /** Map of tab → badge integer. Zero / missing = no badge. */
  badges?: Partial<Record<BottomPanelTab, number>>
  onHide?(): void
  onClose?(): void
  /**
   * Tab-specific action: create a new terminal. Only rendered when the
   * active tab is Terminal (matches VS Code's `+▾` affordance).
   */
  onNewTerminal?(): void
  /**
   * Toggle the panel between its normal height and maximised (full window
   * height). Renders the `⛶` / restore icon in the right toolbar.
   */
  onMaximize?(): void
  isMaximized?: boolean
  /**
   * Open a small overflow menu for panel-level actions (move panel,
   * copy to new window, etc.). Renders `…`.
   */
  onPanelActions?(): void
  moreButtonRef?: React.RefObject<HTMLButtonElement>
  terminalControls?: import("./Terminal").TerminalToolbarControls | null
}

export function PanelTabStrip(props: PanelTabStripProps): React.ReactElement {
  const {
    onNewTerminal,
    onMaximize,
    isMaximized = false,
    onPanelActions,
    moreButtonRef,
  } = props
  const tc = props.activeTab === "Terminal" ? (props.terminalControls ?? null) : null
  const [shellMenuOpen, setShellMenuOpen] = React.useState(false)
  React.useEffect(() => {
    if (props.activeTab !== "Terminal") setShellMenuOpen(false)
  }, [props.activeTab])
  const tabRefs = React.useRef(new Map<BottomPanelTab, HTMLButtonElement>())
  const stripRef = React.useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = React.useState<{ left: number; width: number } | null>(null)

  // After every render, re-measure the active tab so the bar stays
  // pinned even when the surrounding layout reflows (panel resize,
  // window resize, locale change, etc.). We schedule via rAF so the
  // measurement reads post-layout DOM.
  const remeasure = React.useCallback(() => {
    const node = tabRefs.current.get(props.activeTab)
    const strip = stripRef.current
    if (!node || !strip) return
    const stripRect = strip.getBoundingClientRect()
    const tabRect = node.getBoundingClientRect()
    setIndicator({
      left: tabRect.left - stripRect.left,
      width: tabRect.width,
    })
  }, [props.activeTab])

  React.useEffect(() => {
    const r = requestAnimationFrame(remeasure)
    return () => cancelAnimationFrame(r)
  }, [remeasure])

  // Re-measure on viewport resize (panel drag, OS window resize). We
  // listen on `window` because ResizeObserver on the strip alone misses
  // layout caused by ancestor flexbox redistribution.
  React.useEffect(() => {
    const onResize = () => remeasure()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [remeasure])

  return (
    <div className="flex items-center justify-between border-b border-[#2a2a2a] pr-2">
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Bottom panel tabs"
        className="relative flex"
      >
        {BOTTOM_PANEL_TABS.map((t) => {
          const selected = props.activeTab === t
          const badge = props.badges?.[t] ?? 0
          const showBadge = badge > 0
          return (
            <button
              key={t}
              ref={(el) => {
                if (el) tabRefs.current.set(t, el)
                else tabRefs.current.delete(t)
              }}
              type="button"
              role="tab"
              id={`bottompanel-tab-${t}`}
              aria-selected={selected}
              aria-controls={`bottompanel-tabpanel-${t}`}
              aria-label={
                showBadge
                  ? `${t} (${badge} unseen ${badge === 1 ? 'error' : 'errors'})`
                  : t
              }
              tabIndex={selected ? 0 : -1}
              onClick={() => props.onSelect(t)}
              className={`relative px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                selected
                  ? 'text-white'
                  : 'text-[#858585] hover:text-white'
              }`}
              style={{ letterSpacing: '0.04em' }}
            >
              <span className="inline-flex items-center gap-1.5">
                {t}
                {showBadge && (
                  <span
                    data-testid={`tab-badge-${t}`}
                    aria-hidden="true"
                    className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-[#0078d4] px-[3px] text-[9px] font-semibold leading-none text-white"
                  >
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </span>
            </button>
          )
        })}
        {/*
          * The animated active-tab underline. A single 1px-tall absolute
          * bar that slides on `transform`. We always render it so the
          * very first selection still animates from offscreen-left
          * → first tab (~7px). 200ms matches VS Code's tab-switch ease.
          */}
        <span
          aria-hidden="true"
          data-testid="bottompanel-tab-underline"
          className="pointer-events-none absolute bottom-0 h-[1px] bg-[#0e639c]"
          style={{
            width: indicator?.width ?? 0,
            transform: `translateX(${indicator?.left ?? 0}px)`,
            transition: 'transform 200ms ease-out, width 200ms ease-out',
            opacity: indicator ? 1 : 0,
          }}
        />
      </div>
      <div className="flex items-center pl-1">
        {tc ? (
          <div className="flex items-center gap-[1px]">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShellMenuOpen((v) => !v)}
                title="Select Default Profile"
                aria-label={`Terminal profile: ${tc.shellName}`}
                className="flex items-center gap-[4px] rounded px-[6px] py-[3px] text-[11px] text-[#cccccc] hover:bg-[#ffffff1a] hover:text-white"
              >
                <TerminalIcon size={11} className="shrink-0" />
                <span>{tc.shellName}</span>
                <ChevronDown size={9} className="text-[#858585]" />
              </button>
              {shellMenuOpen && (
                <div
                  role="menu"
                  aria-label="Select shell profile"
                  className="absolute right-0 top-full z-50 mt-1 w-32 rounded border border-[#454545] bg-[#252526] py-1 shadow-xl"
                  onMouseLeave={() => setShellMenuOpen(false)}
                >
                  {SHELL_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      role="menuitem"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-[#cccccc] hover:bg-[#0078d4]/60"
                      onClick={() => { tc.onPickProfile(opt); setShellMenuOpen(false); }}
                    >
                      <TerminalIcon size={11} />
                      <span>{SHELL_LABELS[opt] ?? opt}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={tc.onNew}
              title="New Terminal  (⌘⇧`)"
              aria-label="New Terminal"
              className="flex items-center rounded p-[4px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              onClick={tc.onNew}
              title="Launch Profile…"
              aria-label="Launch Profile"
              className="flex items-center rounded p-[4px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
            >
              <ChevronDown size={11} />
            </button>
            <button
              type="button"
              onClick={tc.onSplitRight}
              title="Split Terminal Right  (⌘\)"
              aria-label="Split Terminal"
              className="flex items-center rounded p-[4px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
            >
              <SquareSplitHorizontal size={13} />
            </button>
            <button
              type="button"
              onClick={tc.onKillActive}
              title="Kill Terminal"
              aria-label="Kill Terminal"
              className={`flex items-center rounded p-[4px] hover:bg-[#ffffff1a] ${tc.running ? "text-[#f48771] hover:text-[#f48771]" : "text-[#858585] hover:text-white"}`}
            >
              <Trash2 size={13} />
            </button>
            {onPanelActions && (
              <button
                ref={moreButtonRef}
                type="button"
                onClick={onPanelActions}
                title="Views and More Actions…"
                aria-label="More panel actions"
                className="flex items-center rounded p-[4px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
              >
                <MoreHorizontal size={14} />
              </button>
            )}
            <span aria-hidden="true" className="mx-[3px] h-4 w-px bg-[#3c3c3c]" />
          </div>
        ) : (
          <div className="flex items-center gap-[1px]">
            {onNewTerminal && props.activeTab === "Terminal" && (
              <button
                type="button"
                onClick={onNewTerminal}
                title="New Terminal  (⌘⇧`)"
                aria-label="New Terminal"
                className="flex items-center rounded p-[3px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
              >
                <Plus size={13} />
              </button>
            )}
            {props.onHide && (
              <button
                type="button"
                onClick={props.onHide}
                title="Hide panel  (⌘J)"
                aria-label="Hide panel"
                className="flex items-center rounded p-[3px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
              >
                <ChevronDown size={13} />
              </button>
            )}
            {onPanelActions && (
              <button
                ref={moreButtonRef}
                type="button"
                onClick={onPanelActions}
                title="More panel actions"
                aria-label="More panel actions"
                className="rounded p-[3px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
              >
                <MoreHorizontal size={13} />
              </button>
            )}
            <span aria-hidden="true" className="mx-[3px] h-4 w-px bg-[#3c3c3c]" />
          </div>
        )}
        {onMaximize && (
          <button
            type="button"
            onClick={onMaximize}
            title={isMaximized ? "Restore panel size  (⌘J)" : "Maximize panel size  (⌘J)"}
            aria-label={isMaximized ? "Restore panel size" : "Maximize panel size"}
            aria-pressed={isMaximized}
            className="rounded p-[3px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
        {props.onClose && (
          <button
            type="button"
            onClick={props.onClose}
            title="Close panel"
            aria-label="Close panel"
            className="rounded p-[3px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  )
}
