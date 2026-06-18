// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import * as React from "react";
import { Terminal } from "./Terminal";
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
export function BottomPanel({
  projectId,
  newSessionNonce,
  onClose,
  onReveal,
  agentUrl = null,
  messages,
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
}) {
  const tab = useBottomPanelState((s) => s.activeTab);
  const extensionPanelContainers = useBottomPanelState((s) => s.extensionPanelContainers);
  const unseenForThisProject = useBottomPanelState((s) =>
    projectId ? (s.unseenErrorsByProject[projectId] ?? 0) : 0,
  );

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
      { id: "panel.terminal",     key: "`", mod: true,              run: () => handleSelect("Terminal") },
    ]), [handleSelect]),
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
            newSessionNonce={newSessionNonce}
            onRequestClose={onClose}
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
        onHide={onClose}
        onClose={onClose}
      />
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
