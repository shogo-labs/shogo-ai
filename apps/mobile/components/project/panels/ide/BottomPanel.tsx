// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { ChevronDown, X } from "lucide-react-native";
import { Terminal } from "./Terminal";
import { Problems } from "./Problems";
import { OutputTab } from "./OutputTab";
import {
  BOTTOM_PANEL_TABS,
  ideBottomPanelStore,
  useBottomPanelState,
  type BottomPanelTab,
} from "../../../../lib/ide-bottom-panel-store";

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
  const unseenForThisProject = useBottomPanelState((s) =>
    projectId ? (s.unseenErrorsByProject[projectId] ?? 0) : 0,
  );

  const handleSelect = (next: BottomPanelTab): void => {
    ideBottomPanelStore.setActiveTab(next);
    // Opening the Output tab clears the per-project red dot — we treat
    // "tab visible" as "errors acknowledged" so users don't have to
    // chase the badge.
    if (next === "Output" && projectId) {
      ideBottomPanelStore.markAllSeen(projectId);
    }
  };

  return (
    <div className="relative flex h-full flex-col bg-[#1e1e1e]">
      <div className="flex items-center justify-between border-b border-[#2a2a2a] pr-2">
        <div role="tablist" aria-label="Bottom panel tabs" className="flex">
          {BOTTOM_PANEL_TABS.map((t) => {
            const selected = tab === t;
            const showBadge = t === "Output" && unseenForThisProject > 0;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                id={`bottompanel-tab-${t}`}
                aria-selected={selected}
                aria-controls={`bottompanel-tabpanel-${t}`}
                aria-label={
                  showBadge
                    ? `${t} (${unseenForThisProject} unseen ${
                        unseenForThisProject === 1 ? "error" : "errors"
                      })`
                    : t
                }
                tabIndex={selected ? 0 : -1}
                onClick={() => handleSelect(t)}
                className={`relative px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                  selected
                    ? "text-white border-b-2 border-white"
                    : "text-[#858585] hover:text-white"
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {t}
                  {showBadge && (
                    <span
                      data-testid={`tab-badge-${t}`}
                      aria-hidden="true"
                      className="inline-block h-1.5 w-1.5 rounded-full bg-red-500"
                    />
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onClose}
            title="Hide panel  (⌘J)"
            aria-label="Hide panel"
            className="flex items-center gap-1 rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close panel"
            aria-label="Close panel"
            className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {/*
        * No `overflow-hidden` here on purpose: the Terminal's kebab/preset
        * menu lives inside a child and opens *upward* with `absolute
        * bottom-full`. Clipping here would cut the menu off at the tab-strip
        * edge. Each tab pane self-contains its scroll via its own
        * `overflow-auto`, so we don't need this layer to clip.
        */}
      <div className="relative flex-1 min-h-0">
        <div
          role="tabpanel"
          id="bottompanel-tabpanel-Terminal"
          aria-label="Terminal panel"
          hidden={tab !== "Terminal"}
          className={`absolute inset-0 ${tab === "Terminal" ? "" : "hidden"}`}
        >
          <Terminal
            projectId={projectId}
            agentUrl={agentUrl ?? null}
            visible={tab === "Terminal"}
            newSessionNonce={newSessionNonce}
            onRequestClose={onClose}
          />
        </div>
        <div
          role="tabpanel"
          id="bottompanel-tabpanel-Problems"
          aria-label="Problems panel"
          hidden={tab !== "Problems"}
          className={`absolute inset-0 ${tab === "Problems" ? "" : "hidden"}`}
        >
          <Problems
            projectId={projectId}
            visible={tab === "Problems"}
            onReveal={onReveal}
          />
        </div>
        <div
          role="tabpanel"
          id="bottompanel-tabpanel-Output"
          aria-label="Output panel"
          hidden={tab !== "Output"}
          className={`absolute inset-0 ${tab === "Output" ? "" : "hidden"}`}
        >
          <OutputTab
            projectId={projectId}
            agentUrl={agentUrl}
            messages={messages}
            visible={tab === "Output"}
          />
        </div>
      </div>
    </div>
  );
}
