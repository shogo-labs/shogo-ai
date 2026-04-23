import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separator?: false;
  onClick: () => void;
}

export type MenuEntry = MenuItem | { separator: true };

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const maxX = typeof window !== "undefined" ? window.innerWidth - 220 : x;
  const maxY = typeof window !== "undefined" ? window.innerHeight - items.length * 26 - 10 : y;

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: Math.min(x, maxX), top: Math.min(y, maxY) }}
      className="fixed z-50 min-w-[200px] rounded-md border border-[color:var(--ide-border-muted)] bg-[color:var(--ide-surface)] py-1 shadow-xl text-[color:var(--ide-text)]"
    >
      {items.map((it, i) =>
        "separator" in it && it.separator ? (
          <div key={i} className="my-1 h-px bg-[color:var(--ide-border-muted)]" />
        ) : (
          <button
            key={i}
            disabled={(it as MenuItem).disabled}
            onClick={() => {
              (it as MenuItem).onClick();
              onClose();
            }}
            className={`flex w-full items-center justify-between gap-6 px-3 py-1 text-left text-[13px] ${
              (it as MenuItem).disabled
                ? "cursor-not-allowed text-[color:var(--ide-muted-strong)]"
                : (it as MenuItem).danger
                ? "hover:bg-[color:var(--ide-danger-hover)] hover:text-white"
                : "hover:bg-[color:var(--ide-active-bg)] hover:text-white"
            }`}
          >
            <span className="flex items-center gap-2">
              {(it as MenuItem).icon}
              {(it as MenuItem).label}
            </span>
            {(it as MenuItem).shortcut && (
              <span className="text-[11px] text-[color:var(--ide-muted)]">{(it as MenuItem).shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
