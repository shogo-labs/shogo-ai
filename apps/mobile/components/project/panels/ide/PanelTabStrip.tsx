// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import * as React from 'react'
import { createPortal } from 'react-dom'
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
            <TerminalDropdown tc={tc} />
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

const DROPDOWN_TRIGGER =
  "flex items-center rounded p-[4px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
const DROPDOWN_ITEM =
  "flex w-full items-center px-3 py-[3px] text-left text-[12px] text-[#cccccc] hover:bg-[#04395e] transition-colors"
const DROPDOWN_ITEM_DISABLED =
  "flex w-full items-center px-3 py-[3px] text-left text-[12px] text-[#585858] cursor-default"

function TerminalDropdown({ tc }: { tc: import("./Terminal").TerminalToolbarControls | null }) {
  if (!tc) return null
  const [open, setOpen] = React.useState(false)
  const [subOpen, setSubOpen] = React.useState(false)
  const [activeIdx, setActiveIdx] = React.useState(-1)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  type Item =
    | { kind: "action"; label: string; shortcut?: string; disabled?: boolean }
    | { kind: "separator" }
    | { kind: "profile"; label: string; id: string; checked?: boolean }
    | { kind: "submenu"; label: string; items: { label: string; id: string }[] }

  const profiles = SHELL_OPTIONS.map((s) => ({
    label: SHELL_LABELS[s] ?? s,
    id: s,
  }))

  const items: Item[] = [
    { kind: "action", label: "New Terminal", shortcut: "⌃⇧`" },
    { kind: "action", label: "Split Terminal", shortcut: "⌘\\" },
    { kind: "separator" },
    ...profiles.map((p) => ({ kind: "profile" as const, ...p, checked: tc.shellName === p.id })),
    {
      kind: "submenu",
      label: "Split Terminal with Profile",
      items: profiles,
    },
    { kind: "separator" },
    { kind: "action", label: "Configure Terminal Settings" },
    { kind: "action", label: "Select Default Profile" },
  ]

  const flatItems = items.filter((i) => i.kind !== "separator")

  const activate = React.useCallback(
    (item: Item) => {
      setOpen(false)
      setSubOpen(false)
      if (item.kind === "action") {
        if (item.label === "New Terminal") tc.onNew()
        else if (item.label === "Split Terminal") tc.onSplitRight()
        else if (item.label === "Configure Terminal Settings") tc.onConfigure?.()
        else if (item.label === "Select Default Profile") {
          const next = profiles.find((p) => p.id !== tc.shellName)
          if (next) tc.onPickProfile(next.id as any)
        }
      } else if (item.kind === "profile" && item.id) {
        tc.onNewWithProfile?.(item.id)
      }
    },
    [tc, profiles],
  )

  React.useEffect(() => {
    if (!open) { setActiveIdx(-1); setSubOpen(false) }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) && btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); return }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIdx((p) => Math.min(p + 1, flatItems.length - 1))
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIdx((p) => Math.max(0, p - 1))
      }
      if (e.key === "ArrowRight") {
        if (flatItems[activeIdx]?.kind === "submenu") setSubOpen(true)
      }
      if (e.key === "ArrowLeft" && subOpen) setSubOpen(false)
      if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); activate(flatItems[activeIdx]) }
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey) }
  }, [open, activeIdx, subOpen, flatItems, activate])

  const [menuPos, setMenuPos] = React.useState({ top: 0, left: 0, maxH: 400 })
  const [subPos, setSubPos] = React.useState({ top: 0, left: 0 })

  const calcMenuPos = React.useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const gap = 4
    const menuW = 260
    const subW = 220
    let top = r.bottom + gap
    let left = r.left
    if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 4
    if (left < 4) left = 4
    const maxH = Math.max(120, window.innerHeight - top - 8)
    setMenuPos({ top, left, maxH })
  }, [])

  React.useEffect(() => {
    if (!open) return
    calcMenuPos()
    const onResize = () => calcMenuPos()
    const onScroll = () => calcMenuPos()
    window.addEventListener("resize", onResize)
    window.addEventListener("scroll", onScroll, true)
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("scroll", onScroll, true) }
  }, [open, calcMenuPos])

  React.useEffect(() => {
    if (subOpen && menuRef.current && activeIdx >= 0) {
      const menuEl = menuRef.current
      const menuRect = menuEl.getBoundingClientRect()
      const allButtons = Array.from(menuEl.querySelectorAll('[role="menuitem"]'))
      const activeItemEl = allButtons[activeIdx]
      if (!activeItemEl) return
      const itemRect = activeItemEl.getBoundingClientRect()
      const subItemCount = submenuItem?.items?.length ?? 0
      const subH = subItemCount * 28 + 16
      let top = itemRect.top
      let left = menuRect.right + 4
      if (left + subW > window.innerWidth) left = menuRect.left - subW - 4
      if (top + subH > window.innerHeight) top = window.innerHeight - subH - 4
      if (top < 0) top = 4
      setSubPos({ top, left })
    }
  }, [subOpen, activeIdx])

  const submenuItem = flatItems[activeIdx]?.kind === "submenu" ? (flatItems[activeIdx] as Item) : null
  const subW = 220

  if (!open) return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        className={DROPDOWN_TRIGGER}
        title="Terminal Actions"
        aria-label="Terminal Actions"
        aria-haspopup="menu"
        aria-expanded={false}
      >
        <ChevronDown size={11} />
      </button>
    </div>
  )

  const menu = createPortal(
    React.createElement(
      "div",
      {
        role: "menu",
        "aria-activedescendant": activeIdx >= 0 ? `dropdown-item-${activeIdx}` : undefined,
        className:
          "fixed z-[2147483647] min-w-[260px] overflow-y-auto overflow-x-hidden rounded-md border border-[#454545] bg-[#252526] py-1 shadow-xl",
        style: { top: menuPos.top, left: menuPos.left, maxHeight: menuPos.maxH },
        ref: menuRef,
      },
      ...items.map((item, i) => {
        if (item.kind === "separator") {
          return React.createElement("div", { key: `s-${i}`, className: "my-1 h-px bg-[#454545]" })
        }
        const fi = flatItems.indexOf(item)
        const isActive = fi === activeIdx
        const isSubOpen = subOpen && isActive && item.kind === "submenu"
        return React.createElement(
          "button",
          {
            key: item.label,
            type: "button",
            role: "menuitem",
            id: `dropdown-item-${fi}`,
            disabled: item.kind === "action" && item.disabled,
            onMouseEnter: () => {
              setActiveIdx(fi)
              if (item.kind === "submenu") {
                if (timerRef.current) clearTimeout(timerRef.current)
                setSubOpen(true)
              }
            },
            onMouseLeave: () => {
              if (item.kind === "submenu") {
                timerRef.current = setTimeout(() => setSubOpen(false), 250)
              }
            },
            onClick: () => activate(item),
            className:
              item.kind === "action" && item.disabled
                ? DROPDOWN_ITEM_DISABLED
                : `${DROPDOWN_ITEM} ${isActive || isSubOpen ? "bg-[#04395e]" : ""}`,
          },
          item.kind === "profile" && item.checked
            ? React.createElement("span", { className: "mr-1 text-[#0078d4]" }, "\u2713")
            : null,
          React.createElement("span", { className: "flex-1" }, item.label),
          item.kind === "submenu"
            ? React.createElement("span", { className: "ml-2 text-[#858585]" }, "\u25B6")
            : null,
          item.kind === "action" && item.shortcut
            ? React.createElement("span", { className: "ml-3 text-[10px] text-[#858585]" }, item.shortcut)
            : null,
        )
      }),
    ),
    document.body,
  )

  const submenu = subOpen && submenuItem
    ? createPortal(
        React.createElement(
          "div",
          {
            role: "menu",
            className:
              "fixed z-[2147483647] min-w-[220px] overflow-y-auto overflow-x-hidden rounded-md border border-[#454545] bg-[#252526] py-1 shadow-xl",
            style: { top: subPos.top, left: subPos.left },
            onMouseEnter: () => { if (timerRef.current) clearTimeout(timerRef.current) },
            onMouseLeave: () => setSubOpen(false),
          },
          ...submenuItem.items.map((sub) =>
            React.createElement(
              "button",
              {
                key: sub.id,
                type: "button",
                role: "menuitem",
                onClick: () => {
                  setOpen(false)
                  setSubOpen(false)
                  tc.onSplitWithProfile?.(sub.id)
                },
                className: DROPDOWN_ITEM,
              },
              React.createElement("span", { className: "flex-1" }, sub.label),
            ),
          ),
        ),
        document.body,
      )
    : null

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={DROPDOWN_TRIGGER}
        title="Terminal Actions"
        aria-label="Terminal Actions"
        aria-haspopup="menu"
        aria-expanded={true}
      >
        <ChevronDown size={11} />
      </button>
      {menu}
      {submenu}
    </div>
  )
}
