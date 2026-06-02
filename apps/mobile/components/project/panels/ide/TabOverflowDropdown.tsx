// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * TabOverflowDropdown — the "show all open tabs" menu shown when the
 * editor tab strip overflows.
 *
 * Modelled after VS Code's ▾ menu in the tab bar. Two reasons we expose
 * this even when chevrons are present:
 *
 *   1. Random-access. Chevrons walk one tab at a time; with 30 files
 *      open the user does not want to click ▶ 27 times to reach the
 *      last tab. The dropdown is the O(1) path.
 *
 *   2. Discoverability. The chevrons advertise "scroll me", the ▾
 *      advertises "here is the full list". Different mental models —
 *      shipping both is the canvas prescription.
 *
 * Accessibility / behaviour contract (locked by TabOverflowDropdown
 * .rtl.test.tsx):
 *
 *   • Outer click closes (delegated to a window mousedown listener
 *     rather than blur, so clicking a menu item still fires its
 *     handler before the close).
 *   • Escape closes and refocuses the trigger button (so the user can
 *     keep typing without losing keyboard focus).
 *   • ArrowDown / ArrowUp cycle the highlighted item; Home / End jump
 *     to first / last; Enter activates; Tab closes.
 *   • Items show dirty (●) and pinned (📌) markers, plus the file path
 *     as secondary text so two `index.ts` tabs are distinguishable.
 *   • Active tab is rendered with the "active" accent so it's obvious
 *     which one the editor is showing right now.
 */
import { Circle, Pin } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenFile } from "./types";

interface Props {
  files: OpenFile[];
  activeId: string | null;
  /** Triggered when the user picks a tab from the dropdown.
   *  Consumer is responsible for selecting AND scrolling it into view. */
  onPick: (id: string) => void;
  /** Close the menu (also called after a successful onPick). */
  onClose: () => void;
  /** Element to refocus when the menu closes via Escape — usually the
   *  trigger button. Optional; null means "don't refocus". */
  triggerRef: React.RefObject<HTMLElement | null>;
}

export function TabOverflowDropdown({
  files,
  activeId,
  onPick,
  onClose,
  triggerRef,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<number>(() =>
    Math.max(
      0,
      files.findIndex((f) => f.id === activeId),
    ),
  );

  // Reset highlight when the file set changes underneath us — defends
  // against the highlight pointing at an index that no longer exists.
  useEffect(() => {
    if (highlight >= files.length) setHighlight(Math.max(0, files.length - 1));
  }, [files.length, highlight]);

  const close = useCallback(() => {
    onClose();
    // Defer focus restore so the close-triggered re-render commits first.
    queueMicrotask(() => triggerRef.current?.focus?.());
  }, [onClose, triggerRef]);

  // Outside-click + Escape + Tab — all close paths consolidated here so the
  // listener teardown can't drift out of sync with the install.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      // The trigger button toggles open/close itself; outside-click closes
      // strictly when the click is NOT on the trigger (otherwise we'd
      // race the trigger's onClick and reopen).
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Tab") {
        // Tab leaves the menu — close without refocus so focus moves to
        // the next natural element.
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % Math.max(files.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + files.length) % Math.max(files.length, 1));
      } else if (e.key === "Home") {
        e.preventDefault();
        setHighlight(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setHighlight(Math.max(0, files.length - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = files[highlight];
        if (target) {
          onPick(target.id);
          close();
        }
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [files, highlight, onClose, close, onPick, triggerRef]);

  // Pinned tabs first, matching the strip's own ordering rule.
  const sorted = [...files].sort((a, b) => {
    if (!!a.pinned === !!b.pinned) return 0;
    return a.pinned ? -1 : 1;
  });

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Open editors"
      className="absolute right-0 top-full z-40 mt-px max-h-[60vh] w-[280px] overflow-y-auto rounded-md border border-[color:var(--ide-border-muted)] bg-[color:var(--ide-surface)] py-1 shadow-xl"
    >
      {sorted.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-[color:var(--ide-muted)]">
          No open editors
        </div>
      ) : (
        sorted.map((f, i) => {
          const isActive = f.id === activeId;
          const isHighlighted = i === highlight;
          return (
            <button
              key={f.id}
              role="menuitem"
              data-testid={`tab-overflow-item-${f.id}`}
              aria-current={isActive ? "true" : undefined}
              onMouseEnter={() => setHighlight(i)}
              onClick={(e) => {
                e.stopPropagation();
                onPick(f.id);
                close();
              }}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] ${
                isHighlighted
                  ? "bg-[color:var(--ide-hover)]"
                  : "hover:bg-[color:var(--ide-hover-subtle)]"
              } ${
                isActive
                  ? "text-[color:var(--ide-text-strong)]"
                  : "text-[color:var(--ide-text)]"
              }`}
              title={f.path}
            >
              {f.pinned ? (
                <Pin
                  size={11}
                  className="shrink-0 text-[color:var(--ide-muted)]"
                />
              ) : f.dirty ? (
                <Circle
                  size={8}
                  className="shrink-0 fill-current text-[color:var(--ide-warn)]"
                />
              ) : (
                <span className="inline-block w-[11px] shrink-0" />
              )}
              <span className="truncate font-medium">{f.name}</span>
              <span className="ml-auto truncate text-[10px] text-[color:var(--ide-muted)]">
                {f.path}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
