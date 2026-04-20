import { X, Circle, Pin } from "lucide-react-native";
import type { OpenFile } from "./types";

export function EditorTabs({
  files,
  activeId,
  onSelect,
  onClose,
  onTogglePin,
  onFocus,
  groupFocused,
}: {
  files: OpenFile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin?: (id: string) => void;
  onFocus?: () => void;
  groupFocused?: boolean;
}) {
  if (files.length === 0) return null;
  const sorted = [...files].sort((a, b) => {
    if (!!a.pinned === !!b.pinned) return 0;
    return a.pinned ? -1 : 1;
  });
  return (
    <div
      onMouseDown={onFocus}
      className="flex h-9 items-stretch bg-[#1e1e1e] border-b border-[#2a2a2a] overflow-x-auto"
    >
      {sorted.map((f) => {
        const isActive = f.id === activeId;
        const accent = isActive && groupFocused !== false ? "#0078d4" : "#555";
        return (
          <div
            key={f.id}
            className={`group flex cursor-pointer items-center gap-2 border-r border-[#2a2a2a] px-3 text-[13px] ${
              isActive
                ? "bg-[#1e1e1e] text-white"
                : "bg-[#2d2d2d] text-[#969696] hover:text-white"
            }`}
            style={isActive ? { borderTop: `2px solid ${accent}`, marginTop: -1 } : undefined}
            onClick={() => onSelect(f.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(f.id);
              }
            }}
          >
            {f.pinned && <Pin size={11} className="text-[#858585]" />}
            <span className="truncate max-w-[180px]">{f.name}</span>
            <button
              title={f.pinned ? "Unpin" : f.dirty ? "Close (unsaved)" : "Close"}
              className="flex h-4 w-4 items-center justify-center rounded-sm hover:bg-[#ffffff1a]"
              onClick={(e) => {
                e.stopPropagation();
                if (f.pinned && onTogglePin) onTogglePin(f.id);
                else onClose(f.id);
              }}
            >
              {f.pinned ? (
                <Pin size={11} className="opacity-70 hover:opacity-100" />
              ) : f.dirty ? (
                <Circle size={8} className="fill-current" />
              ) : (
                <X size={12} className="opacity-0 group-hover:opacity-100" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
