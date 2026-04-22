import { useCallback, useEffect, useRef, useState } from "react";

export function useResizable({
  initial,
  min,
  max,
  direction,
}: {
  initial: number;
  min: number;
  max: number;
  direction: "horizontal" | "vertical";
}) {
  const [size, setSize] = useState(initial);
  const dragging = useRef(false);
  const start = useRef({ pos: 0, size: 0 });

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      start.current = {
        pos: direction === "horizontal" ? e.clientX : e.clientY,
        size,
      };
      document.body.style.cursor =
        direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [direction, size],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta =
        (direction === "horizontal" ? e.clientX : e.clientY) - start.current.pos;
      const next = Math.min(max, Math.max(min, start.current.size + delta));
      setSize(next);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [direction, min, max]);

  return { size, setSize, onMouseDown };
}

export function VerticalSplit({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  // Thin visual seam (1px) but a fat invisible hit area (7px) so users can
  // grab it without precision aim. Hover shows the accent colour.
  return (
    <div
      onMouseDown={onMouseDown}
      className="group relative w-[1px] shrink-0 cursor-col-resize bg-[#2a2a2a]"
    >
      <div
        aria-hidden
        className="absolute inset-y-0 -left-[3px] -right-[3px] group-hover:bg-[#0078d4]/60 transition-colors"
      />
    </div>
  );
}

export function HorizontalSplit({
  onMouseDown,
  onDoubleClick,
}: {
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      title="Drag to resize · double-click to reset"
      className="group relative h-[1px] shrink-0 cursor-row-resize bg-[#2a2a2a]"
    >
      <div
        aria-hidden
        className="absolute inset-x-0 -top-[3px] -bottom-[3px] group-hover:bg-[#0078d4]/60 transition-colors"
      />
    </div>
  );
}
