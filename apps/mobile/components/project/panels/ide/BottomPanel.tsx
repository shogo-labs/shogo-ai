// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import * as React from "react";
import { Terminal, type TerminalToolbarControls } from "./Terminal";
import { Problems } from "./Problems";
import { OutputTab } from "./OutputTab";
import { DebugConsole } from "./DebugConsole";
import { Ports } from "./Ports";
import { PanelTabStrip } from "./PanelTabStrip";
import { ExtensionRuntimeViewlet } from "./extensions/ExtensionRuntimeViewlet";
import { getDesktopExtensionsBridge } from "./extensions/useExtensions";
import type { ExtensionRuntimeContainer } from "./extensions/ExtensionRuntimeViewlet";
import type { ExtensionRuntimeViewResult } from "./extensions/types";
import {
  ideBottomPanelStore,
  useBottomPanelState,
  type BottomPanelTab,
} from "../../../../lib/ide-bottom-panel-store";
import { useGlobalShortcuts } from "../../../../hooks/useGlobalShortcuts";

/**
 * VS Code-style bottom panel. Hosts Terminal / Problems / Output.
 *
 * Tab state, drawer open/close, size, and per-project unseen-error counts
 * all live in `apps/mobile/lib/ide-bottom-panel-store.ts` so that:
 *   - ⌘J / ⌘⇧` keybinds that fire from anywhere in the project view
 *     (Workbench, status bar, command palette) hit the same drawer the
 *     ProjectLayout is rendering.
 *   - The Output tab's red-dot badge is consistent across re-mounts
 *     (Canvas → IDE → Files cycles don't clear it).
 *
 * The Terminal tab is the default. Parents pass a `newSessionNonce` that
 * the Terminal component watches so the ⌘⇧` keybind can spawn a new
 * terminal session without owning sessions state here.
 *
 * Accessibility — every interactive element exposes an accessible name
 * via `role`/`aria-*` so tests can query by role rather than implementation
 * details (Tailwind class strings). See `BottomPanel.rtl.test.tsx`.
 */

function PanelMenuItem({
  label,
  shortcut,
  onClick,
  disabled = false,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-xs ${
        disabled ? "cursor-default text-[#585858]" : "text-[#cccccc] hover:bg-[#0078d4]/60"
      }`}
      onClick={disabled ? undefined : onClick}
    >
      <span>{label}</span>
      {shortcut && <span className="ml-6 text-[#858585]">{shortcut}</span>}
    </button>
  );
}

export function BottomPanel({
  projectId,
  newSessionNonce,
  onClose,
  onReveal,
  agentUrl = null,
  messages,
  onMaximizeChange,
  folderPath,
}: {
  projectId: string | null | undefined;
  newSessionNonce: number;
  onClose: () => void;
  /** Reveal a workspace file at (line, col). Wired by Workbench. */
  onReveal?: (path: string, line: number, column: number) => void;
  /** Agent runtime URL — passed through to the Output tab's SSE/poll hook. */
  agentUrl?: string | null;
  /** Chat messages — Output tab folds in chat-derived exec entries. */
  messages?: any[];
  /**
   * Called when the user clicks the maximize/restore button. The parent
   * (Workbench / ProjectLayout) should expand the panel to fill the window
   * when `maximized` is true, and restore its prior height when false.
   */
  onMaximizeChange?: (maximized: boolean) => void;
  /** Filesystem path of the opened project folder. */
  folderPath?: string
}) {
  const tab = useBottomPanelState((s) => s.activeTab);
  const extensionPanelContainers = useBottomPanelState((s) => s.extensionPanelContainers);
  const unseenForThisProject = useBottomPanelState((s) =>
    projectId ? (s.unseenErrorsByProject[projectId] ?? 0) : 0,
  );

  // Local nonce incremented by the "New Terminal" panel-header button.
  const [localNewNonce, setLocalNewNonce] = React.useState(0);
  const effectiveNewSessionNonce = (newSessionNonce ?? 0) + localNewNonce;

  const [terminalControls, setTerminalControls] = React.useState<TerminalToolbarControls | null>(null);

  // Panel maximize — fills window height; hides the editor area.
  const [isMaximized, setIsMaximized] = React.useState(false);
  const [panelActionsOpen, setPanelActionsOpen] = React.useState(false);
  const moreButtonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = React.useState<{ top: number; right: number; maxH: number } | null>(null);

  React.useEffect(() => {
    if (!panelActionsOpen) return;
    const recalc = () => {
      const btn = moreButtonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const spaceAbove = r.top - 8;
      const fitsBelow = spaceBelow >= 200;
      const maxH = Math.min(Math.max(fitsBelow ? spaceBelow : spaceAbove, 120), window.innerHeight - 24);
      const top = fitsBelow ? r.bottom + 4 : r.top - Math.min(maxH, 400) - 4;
      setMenuPos({ top, right: window.innerWidth - r.right, maxH });
    };
    const onPointerDown = (e: PointerEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        moreButtonRef.current && !moreButtonRef.current.contains(e.target as Node)
      ) {
        setPanelActionsOpen(false);
      }
    };
    window.addEventListener('resize', recalc, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => {
      window.removeEventListener('resize', recalc);
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
    };
  }, [panelActionsOpen]);
  const onMaximizeChangeRef = React.useRef(onMaximizeChange);
  onMaximizeChangeRef.current = onMaximizeChange;
  const handleMaximize = React.useCallback(() => {
    setIsMaximized((v) => {
      const next = !v;
      onMaximizeChangeRef.current?.(next);
      return next;
    });
  }, []);

  const handleSelect = React.useCallback((next: BottomPanelTab): void => {
    ideBottomPanelStore.setActiveTab(next);
    // Opening the Output tab clears the per-project red dot — we treat
    // "tab visible" as "errors acknowledged" so users don't have to
    // chase the badge.
    if (next === "Output" && projectId) {
      ideBottomPanelStore.markAllSeen(projectId);
    }
  }, [projectId]);

  const runExtensionCommand = React.useCallback((commandId: string, args?: unknown[], workspaceRoot?: string | null): void => {
    const bridge = getDesktopExtensionsBridge();
    if (!bridge) return;
    void bridge.runCommand(commandId, args ?? [], workspaceRoot ?? undefined);
  }, []);

  const loadExtensionRuntimeView = React.useCallback(async (viewId: string, workspaceRoot?: string | null, itemHandle?: string): Promise<ExtensionRuntimeViewResult | null> => {
    const bridge = getDesktopExtensionsBridge();
    if (!bridge) return null;
    const response = await bridge.getView(viewId, workspaceRoot ?? undefined, itemHandle);
    if (!response.ok) throw new Error(response.error ?? `Extension view failed: ${viewId}`);
    return response.view ?? null;
  }, []);

  /**
   * Phase 11 — VS Code global shortcuts. Bound at the panel level (not
   * Workbench) so the keys keep working when the panel is closed too;
   * the caller decides whether to also auto-open. We don't bind a
   * default for Ports (matches VS Code 1.95).
   */
  useGlobalShortcuts(
    React.useMemo(() => ([
      { id: "panel.problems",     key: "m", mod: true, shift: true, run: () => handleSelect("Problems") },
      { id: "panel.output",       key: "u", mod: true, shift: true, run: () => handleSelect("Output") },
      { id: "panel.debugConsole", key: "y", mod: true, shift: true, run: () => handleSelect("Debug Console") },
      // NOTE: Ctrl+` is intentionally NOT bound here — Workbench.tsx owns
      // the panel toggle (⌘J / view.toggleBottomPanel) and Ctrl+` in
      // Electron also maps to "Toggle DevTools", causing a conflict.
      { id: "panel.maximize",     key: "j", mod: true,              run: handleMaximize },
    ]), [handleSelect, handleMaximize]),
  );

  // Per-tab pane wiring. Kept as a small inline table so the JSX below
  // stays a clean map over `BOTTOM_PANEL_TABS` — no per-tab special
  // cases creep into the layout layer.
  const renderPane = (t: BottomPanelTab): React.ReactNode => {
    const visible = tab === t;
    if (t.startsWith("extension:")) {
      const container = extensionPanelContainers.find((candidate) => candidate.activityId === t);
      if (!container) return null;
      return (
        <ExtensionRuntimeViewlet
          container={container as ExtensionRuntimeContainer}
          onRunCommand={(commandId, args) => runExtensionCommand(commandId, args, container.workspaceRoot)}
          onOpenDetails={() => undefined}
          onLoadView={(viewId, itemHandle) => loadExtensionRuntimeView(viewId, container.workspaceRoot, itemHandle)}
        />
      );
    }
    switch (t) {
      case "Terminal":
        return (
          <Terminal
            projectId={projectId}
            visible={visible}
            newSessionNonce={effectiveNewSessionNonce}
            onRequestClose={onClose}
            onControlsChange={setTerminalControls}
            folderPath={folderPath}
          />
        );
      case "Problems":
        return (
          <Problems
            projectId={projectId}
            visible={visible}
            onReveal={onReveal}
          />
        );
      case "Output":
        return (
          <OutputTab
            projectId={projectId}
            agentUrl={agentUrl}
            messages={messages}
            visible={visible}
          />
        );
      case "Debug Console":
        return <DebugConsole visible={visible} />;
      case "Ports":
        return <Ports visible={visible} />;
    }
  };

  return (
    <div className="relative flex h-full flex-col bg-[#1e1e1e]">
      <PanelTabStrip
        activeTab={tab}
        onSelect={handleSelect}
        badges={{ Output: unseenForThisProject }}
        extensionTabs={extensionPanelContainers}
        onNewTerminal={() => setLocalNewNonce((n) => n + 1)}
        onMaximize={handleMaximize}
        isMaximized={isMaximized}
        onPanelActions={() => {
          const btn = moreButtonRef.current;
          if (btn) {
            const r = btn.getBoundingClientRect();
            const spaceBelow = window.innerHeight - r.bottom - 8;
            const spaceAbove = r.top - 8;
            const fitsBelow = spaceBelow >= 200;
            const maxH = Math.min(Math.max(fitsBelow ? spaceBelow : spaceAbove, 120), window.innerHeight - 24);
            const top = fitsBelow ? r.bottom + 4 : r.top - Math.min(maxH, 400) - 4;
            const right = window.innerWidth - r.right;
            setMenuPos({ top, right, maxH });
          }
          setPanelActionsOpen((v) => !v);
        }}
        moreButtonRef={moreButtonRef}
        onHide={onClose}
        onClose={onClose}
        terminalControls={terminalControls}
      />
      {panelActionsOpen && menuPos && (
        <div
          role="menu"
          aria-label="Panel actions"
          style={{
            position: 'fixed',
            top: menuPos.top,
            right: menuPos.right,
            maxHeight: menuPos.maxH,
            zIndex: 9999,
          }}
          ref={menuRef}
          className="w-64 min-w-[180px] overflow-y-auto rounded-md border border-[#454545] bg-[#252526] py-1 shadow-xl"
        >
          {tab === "Terminal" && terminalControls && (
            <>
              <PanelMenuItem
                label="Scroll to Previous Command"
                shortcut="⌘↑"
                disabled={!terminalControls.canScrollPrev || terminalControls.commandCount < 2}
                onClick={() => { terminalControls.onScrollPrevCommand(); setPanelActionsOpen(false); }}
              />
              <PanelMenuItem
                label="Scroll to Next Command"
                shortcut="⌘↓"
                disabled={!terminalControls.canScrollNext || terminalControls.commandCount < 2}
                onClick={() => { terminalControls.onScrollNextCommand(); setPanelActionsOpen(false); }}
              />
              <PanelMenuItem
                label="Clear Terminal"
                shortcut="⌘K"
                onClick={() => { terminalControls.onClear(); setPanelActionsOpen(false); }}
                disabled={terminalControls.clearDisabled}
              />
              <PanelMenuItem
                label="Run Active File"
                onClick={() => { terminalControls.onRunActiveFile(); setPanelActionsOpen(false); }}
              />
              <PanelMenuItem
                label="Run Selected Text"
                onClick={() => { terminalControls.onRunSelectedText(); setPanelActionsOpen(false); }}
              />
              <div className="my-1 border-t border-[#454545]" />
              <PanelMenuItem
                label="Go to Recent Directory..."
                shortcut="⌘G"
                onClick={() => { terminalControls.onGoToRecentDirectory(); setPanelActionsOpen(false); }}
              />
              <PanelMenuItem
                label="Run Recent Command..."
                shortcut="⌃⌥R"
                onClick={() => { terminalControls.onRunRecent(); setPanelActionsOpen(false); }}
              />
              <div className="my-1 border-t border-[#454545]" />
            </>
          )}
          <PanelMenuItem
            label={isMaximized ? "Restore Panel Size" : "Maximize Panel Size"}
            onClick={() => { handleMaximize(); setPanelActionsOpen(false); }}
          />
          <PanelMenuItem
            label="Close Panel"
            onClick={() => { onClose?.(); setPanelActionsOpen(false); }}
          />
        </div>
      )}
      {/*
        * No `overflow-hidden` here on purpose: the Terminal's kebab/preset
        * menu lives inside a child and opens *upward* with `absolute
        * bottom-full`. Clipping here would cut the menu off at the tab-strip
        * edge. Each tab pane self-contains its scroll via its own
        * `overflow-auto`, so we don't need this layer to clip.
        */}
      <div className="relative flex-1 min-h-0">
        {(["Problems", "Output", "Debug Console", "Terminal", "Ports", ...extensionPanelContainers.map((container) => container.activityId)] as const).map((t) => (
          <div
            key={t}
            role="tabpanel"
            id={`bottompanel-tabpanel-${t}`}
            aria-label={`${extensionPanelContainers.find((container) => container.activityId === t)?.title ?? t} panel`}
            hidden={tab !== t}
            className={`absolute inset-0 ${tab === t ? "" : "hidden"}`}
          >
            {renderPane(t)}
          </div>
        ))}
      </div>
    </div>
  );
}
