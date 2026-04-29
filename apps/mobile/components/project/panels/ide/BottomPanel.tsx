// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from "react";
import { ChevronDown, X } from "lucide-react-native";
import { Terminal } from "./Terminal";
import { Problems } from "./Problems";

const TABS = ["Terminal", "Problems", "Output"] as const;
type TabId = (typeof TABS)[number];

/**
 * VS Code-style bottom panel. Hosts Terminal / Problems / Output.
 *
 * The panel's visibility is controlled from Workbench (⌘J / Activity Bar
 * terminal button). The Terminal tab is the default, and parents pass a
 * `newSessionNonce` that the Terminal component watches so the ⌘⇧` keybind
 * can create a new terminal session without owning the sessions state here.
 */
export function BottomPanel({
  projectId,
  newSessionNonce,
  onClose,
  onReveal,
}: {
  projectId: string | null | undefined;
  newSessionNonce: number;
  onClose: () => void;
  /** Reveal a workspace file at (line, col). Wired by Workbench. */
  onReveal?: (path: string, line: number, column: number) => void;
}) {
  const [tab, setTab] = useState<TabId>("Terminal");

  return (
    <div className="relative flex h-full flex-col bg-[#1e1e1e]">
      <div className="flex items-center justify-between border-b border-[#2a2a2a] pr-2">
        <div className="flex">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                tab === t
                  ? "text-white border-b-2 border-white"
                  : "text-[#858585] hover:text-white"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onClose}
            title="Hide panel  (⌘J)"
            className="flex items-center gap-1 rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            <ChevronDown size={14} />
          </button>
          <button
            onClick={onClose}
            title="Close panel"
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
        <div className={`absolute inset-0 ${tab === "Terminal" ? "" : "hidden"}`}>
          <Terminal
            projectId={projectId}
            visible={tab === "Terminal"}
            newSessionNonce={newSessionNonce}
            onRequestClose={onClose}
          />
        </div>
        <div className={`absolute inset-0 ${tab === "Problems" ? "" : "hidden"}`}>
          <Problems
            projectId={projectId}
            visible={tab === "Problems"}
            onReveal={onReveal}
          />
        </div>
        {tab === "Output" && (
          <div className="h-full p-3 font-mono text-[12px] text-[#858585]">
            Output channel — nothing to show yet.
          </div>
        )}
      </div>
    </div>
  );
}
