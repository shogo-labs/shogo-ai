// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * os-drop-zone.ts — the stateful half of SHO-215: one drop zone for the whole
 * IDE instead of the per-row/per-footer handlers the Explorer used to carry.
 *
 * The listeners are native **capture** listeners on `document`, scoped to the
 * IDE subtree (plus any `[data-os-drop-scope]` element — the bottom drawer is
 * mounted outside the Workbench, at the project layout level). Capture is what
 * makes this reliable: nothing inside — Monaco, a tab strip, the terminal —
 * can swallow the drag before we see it.
 *
 *   - `preventDefault()` on every OS-file `dragenter`/`dragover` in scope.
 *     That is the actual bug: the tree container never accepted the drop, so
 *     most of the sidebar refused it, and in Electron the drop fell through to
 *     `will-navigate` (the window silently swallowed a `file://` navigation) —
 *     nothing uploaded and nothing said why.
 *   - Over a tree row the overlay stays hidden and `FileTree`'s own highlight
 *     shows the destination folder.
 *   - Anywhere else in scope (empty sidebar, Explorer header, editor, tabs,
 *     bottom panel) a translucent overlay names the destination root.
 *
 * A depth counter keeps the overlay from flickering as `dragleave` fires on
 * every child cross-over; it is force-cleared on drop, `dragend` and window
 * blur, since an OS drag that leaves the window doesn't always report back.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  collectDroppedEntries,
  isOsFileDrag,
  resolveDropTarget,
  type DropDestination,
  type DroppedEntry,
} from "./os-drop";

/** Marks a subtree outside the IDE root that still accepts OS file drops. */
export const OS_DROP_SCOPE_ATTR = "data-os-drop-scope";

export interface UseOsFileDropOptions {
  /** Called once per drop with every file found, and the folder it lands in. */
  onDrop: (entries: DroppedEntry[], dest: DropDestination | null) => void;
  /** The IDE root element. */
  scopeRef: RefObject<HTMLElement | null>;
  /** Turn the zone off while the IDE pane is hidden. Default `true`. */
  enabled?: boolean;
}

export interface UseOsFileDropResult {
  /** True while an OS file drag hovers a part of the IDE that isn't a row. */
  active: boolean;
}

export function useOsFileDrop({
  onDrop,
  scopeRef,
  enabled = true,
}: UseOsFileDropOptions): UseOsFileDropResult {
  const [active, setActive] = useState(false);
  const depthRef = useRef(0);
  // Latest callback without re-binding the document listeners every render.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const reset = useCallback(() => {
    depthRef.current = 0;
    setActive(false);
  }, []);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    const inScope = (target: EventTarget | null): boolean => {
      const el = target as Element | null;
      if (!el || typeof el.closest !== "function") return false;
      const root = scopeRef.current;
      if (root && (root === el || root.contains(el))) return true;
      return el.closest(`[${OS_DROP_SCOPE_ATTR}]`) !== null;
    };

    const onDragEnter = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer) || !inScope(e.target)) return;
      e.preventDefault();
      depthRef.current += 1;
    };

    const onDragOver = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer) || !inScope(e.target)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      // React bails out on an unchanged value, so the constant stream of
      // dragover events costs no re-renders.
      setActive(resolveDropTarget(e.target as Element | null) === null);
    };

    const onDragLeave = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setActive(false);
    };

    const onDrop = (e: DragEvent) => {
      if (!isOsFileDrag(e.dataTransfer) || !inScope(e.target)) return;
      e.preventDefault();
      const dest = resolveDropTarget(e.target as Element | null);
      // Collect before resetting: `dataTransfer` dies with the event.
      const pending = collectDroppedEntries(e.dataTransfer as DataTransfer);
      reset();
      void pending.then((entries) => {
        if (entries.length > 0) onDropRef.current(entries, dest);
      });
    };

    const onBlur = () => reset();

    document.addEventListener("dragenter", onDragEnter, true);
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("dragleave", onDragLeave, true);
    document.addEventListener("drop", onDrop, true);
    document.addEventListener("dragend", onBlur, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("dragenter", onDragEnter, true);
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("dragleave", onDragLeave, true);
      document.removeEventListener("drop", onDrop, true);
      document.removeEventListener("dragend", onBlur, true);
      window.removeEventListener("blur", onBlur);
      depthRef.current = 0;
    };
  }, [enabled, reset, scopeRef]);

  return { active };
}
