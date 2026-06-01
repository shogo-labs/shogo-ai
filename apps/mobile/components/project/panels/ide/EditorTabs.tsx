import { X, Circle, Pin } from "lucide-react-native";
import { useCallback, useState } from "react";
import type { OpenFile } from "./types";
import { useDragCancel } from "./useDragCancel";

type DropPos = "before" | "after";

export function EditorTabs({
  files,
  activeId,
  onSelect,
  onClose,
  onTogglePin,
  onReorder,
  onFocus,
  groupFocused,
}: {
  files: OpenFile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin?: (id: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  onFocus?: () => void;
  groupFocused?: boolean;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    { id: string; pos: DropPos } | null
  >(null);

  // BUG-011 — Single source of truth for "drag is over, clear everything".
  // Used by onDragEnd, onDrop's commit path, AND useDragCancel's Esc/blur/
  // visibility-change fallbacks. Centralising means a future drag-state
  // field can never drift between the dragend path and the Esc path.
  const cancelDrag = useCallback(() => {
    setDragId(null);
    setDropTarget(null);
  }, []);

  // Listen for Esc / window-blur / tab-hidden while a drag is in
  // progress. The HTML5 dragend event is unreliable in Electron and
  // when focus leaves the renderer; this is the belt-and-braces clear.
  useDragCancel(dragId !== null, cancelDrag);

  // Visual order: pinned tabs stay before unpinned (stable within each group).
  const sorted = [...files].sort((a, b) => {
    if (!!a.pinned === !!b.pinned) return 0;
    return a.pinned ? -1 : 1;
  });

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, overId: string) => {
      if (!dragId || dragId === overId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const pos: DropPos =
        e.clientX < rect.left + rect.width / 2 ? "before" : "after";
      setDropTarget((prev) =>
        prev && prev.id === overId && prev.pos === pos ? prev : { id: overId, pos },
      );
    },
    [dragId],
  );

  const commitDrop = useCallback(() => {
    if (!dragId || !dropTarget || !onReorder) {
      cancelDrag();
      return;
    }
    if (dragId === dropTarget.id) {
      cancelDrag();
      return;
    }
    // Reorder against the underlying (unsorted) files array so pin sort still
    // applies on re-render.
    const ids = files.map((f) => f.id);
    const fromIdx = ids.indexOf(dragId);
    const targetIdx = ids.indexOf(dropTarget.id);
    if (fromIdx < 0 || targetIdx < 0) {
      cancelDrag();
      return;
    }
    const next = ids.filter((x) => x !== dragId);
    const targetInNext = next.indexOf(dropTarget.id);
    const insertAt = dropTarget.pos === "before" ? targetInNext : targetInNext + 1;
    next.splice(insertAt, 0, dragId);
    onReorder(next);
    cancelDrag();
  }, [dragId, dropTarget, files, onReorder, cancelDrag]);

  if (files.length === 0) return null;

  return (
    <div
      onMouseDown={onFocus}
      onDragOver={(e) => {
        if (dragId) e.preventDefault();
      }}
      className="relative flex h-9 items-stretch bg-[color:var(--ide-bg)] border-b border-[color:var(--ide-border)] overflow-x-auto"
    >
      {sorted.map((f) => {
        const isActive = f.id === activeId;
        const isFocusedActive = isActive && groupFocused !== false;
        const isDragging = dragId === f.id;
        const showBefore = dropTarget?.id === f.id && dropTarget.pos === "before";
        const showAfter = dropTarget?.id === f.id && dropTarget.pos === "after";
        return (
          <div
            key={f.id}
            draggable={!!onReorder}
            onDragStart={(e) => {
              if (!onReorder) return;
              setDragId(f.id);
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                try {
                  e.dataTransfer.setData("text/plain", f.id);
                } catch {
                  /* Safari quirk — ignore */
                }
              }
            }}
            onDragOver={(e) => handleDragOver(e, f.id)}
            onDragLeave={(e) => {
              // Only clear if pointer actually left this tab (not moved to a child)
              const related = e.relatedTarget as Node | null;
              if (related && e.currentTarget.contains(related)) return;
              setDropTarget((prev) => (prev?.id === f.id ? null : prev));
            }}
            onDrop={(e) => {
              e.preventDefault();
              commitDrop();
            }}
            onDragEnd={cancelDrag}
            className={`group relative flex cursor-pointer items-center gap-2 border-r border-[color:var(--ide-border)] px-3 text-[13px] transition-opacity ${
              isActive
                ? "bg-[color:var(--ide-bg)] text-[color:var(--ide-text-strong)]"
                : "bg-[color:var(--ide-tab-inactive)] text-[color:var(--ide-tab-inactive-text)] hover:text-[color:var(--ide-text-strong)]"
            } ${isDragging ? "opacity-40" : ""}`}
            style={
              isActive
                ? {
                    borderTop: `2px solid ${
                      isFocusedActive
                        ? "var(--ide-active-ring)"
                        : "var(--ide-border-strong)"
                    }`,
                    marginTop: -1,
                  }
                : undefined
            }
            onClick={() => onSelect(f.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(f.id);
              }
            }}
          >
            {showBefore && (
              <span className="pointer-events-none absolute left-0 top-0 h-full w-[2px] bg-[color:var(--ide-active-ring)]" />
            )}
            {f.pinned && <Pin size={11} className="text-[color:var(--ide-muted)]" />}
            <span className="truncate max-w-[120px] sm:max-w-[160px] lg:max-w-[220px]">{f.name}</span>
            <button
              title={f.pinned ? "Unpin" : f.dirty ? "Close (unsaved)" : "Close"}
              className="flex h-4 w-4 items-center justify-center rounded-sm hover:bg-[color:var(--ide-hover-subtle)]"
              onClick={(e) => {
                e.stopPropagation();
                if (f.pinned && onTogglePin) onTogglePin(f.id);
                else onClose(f.id);
              }}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
            >
              {f.pinned ? (
                <Pin size={11} className="opacity-70 hover:opacity-100" />
              ) : f.dirty ? (
                <Circle size={8} className="fill-current" />
              ) : (
                <X size={12} className="opacity-0 group-hover:opacity-100" />
              )}
            </button>
            {showAfter && (
              <span className="pointer-events-none absolute right-0 top-0 h-full w-[2px] bg-[color:var(--ide-active-ring)]" />
            )}
          </div>
        );
      })}
    </div>
  );
}
