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
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 cursor-col-resize bg-[#2a2a2a] hover:bg-[#0078d4] transition-colors"
    />
  );
}

export function HorizontalSplit({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="h-1 cursor-row-resize bg-[#2a2a2a] hover:bg-[#0078d4] transition-colors"
    />
  );
}
