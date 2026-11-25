// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Web-only drag handle on the right edge of the project chat column: dragging
 * it resizes the chat/canvas split, keeping the offset the handle was grabbed
 * with, and two presses in a row restore the default chat width.
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { usePressCounter } from './usePressCounter'

export function ChatPanelResizeHandle({
  splitRowRef,
  chatPanelWidth,
  minWidth,
  maxWidth,
  onResize,
  onResizeEnd,
  onReset,
  leftOffset = 0,
  rightOffset = 0,
  hitWidth = 20,
}: {
  splitRowRef: RefObject<View | null>;
  chatPanelWidth: number;
  minWidth: number;
  maxWidth: number;
  onResize: (w: number) => void;
  onResizeEnd: (w: number) => void;
  onReset: () => void;
  /** Pixels of fixed-width content (e.g. the chat history sidebar) sitting to the left of the resizable chat panel. */
  leftOffset?: number;
  /** Pixels from the chat panel's right edge where the *visible* bar is drawn.
   *  The grabbable hit zone always extends all the way to the right edge so
   *  the (thin) scrollbar area is also a valid drag target. */
  rightOffset?: number;
  /** Total width of the (transparent) grab zone, measured from the chat
   *  panel's right edge. Should be larger than `rightOffset` so the bar
   *  itself is comfortably inside the hit area. */
  hitWidth?: number;
}) {
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const latestWidthRef = useRef(chatPanelWidth);
  const { beginPress, movePress, endPress } = usePressCounter(onReset);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      // A second press in a row resets instead of dragging; a press that moved
      // can never be half of a double-click (see `usePressCounter`).
      if (beginPress(e)) return;
      setDragging(true);

      const container = splitRowRef.current as unknown as HTMLElement | null;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();

      // Distance from the cursor at pointerdown to the chat panel's right
      // edge. We hold this constant during the drag so that grabbing the
      // handle off-center doesn't snap the panel to the cursor position
      // (the handle is now inset from the right edge by `rightOffset`, so
      // the cursor is meaningfully to the left of the actual edge).
      const currentRightEdgeX =
        containerRect.left + leftOffset + chatPanelWidth;
      const grabDx = currentRightEdgeX - e.clientX;

      // Transparent fixed overlay over the whole viewport. Without this,
      // any iframe under the cursor (canvas / preview) swallows the
      // pointermove events and the resize freezes the moment the cursor
      // crosses into the iframe. The overlay's high z-index keeps it on
      // top of every iframe; pointer-events stays default ("auto") so
      // pointermove fires on `document` as expected.
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;cursor:col-resize;background:transparent;";
      document.body.appendChild(overlay);

      const onPointerMove = (ev: PointerEvent) => {
        if (!movePress(ev)) return;
        const newWidth = Math.max(
          minWidth,
          Math.min(
            maxWidth,
            ev.clientX + grabDx - containerRect.left - leftOffset
          )
        );
        latestWidthRef.current = newWidth;
        onResize(newWidth);
      };

      const onPointerUp = () => {
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        overlay.remove();
        setDragging(false);
        // Released in place is a click: it arms the next press as a
        // double-click and commits no width nobody dragged.
        if (endPress()) return;
        onResizeEnd(latestWidthRef.current);
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [
      splitRowRef,
      minWidth,
      maxWidth,
      onResize,
      onResizeEnd,
      leftOffset,
      chatPanelWidth,
      beginPress,
      movePress,
      endPress,
    ]
  );

  const active = dragging || hovered;

  return (
    <View
      accessibilityLabel="Resize chat panel"
      // @ts-expect-error web-only event handlers
      onPointerDown={handlePointerDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        right: 0,
        width: hitWidth,
        cursor: "col-resize" as any,
        zIndex: 21,
      }}
    >
      <View
        className={cn(
          "absolute top-0 bottom-0 transition-all duration-150",
          active ? "bg-primary/40" : "bg-transparent"
        )}
        style={{ right: rightOffset, width: active ? 3 : 1 }}
      />
    </View>
  );
}
