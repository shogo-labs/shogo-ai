import { X, Circle } from "lucide-react";
import type { OpenFile } from "./types";

export function EditorTabs({
  files,
  activeId,
  onSelect,
  onClose,
}: {
  files: OpenFile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex h-9 items-stretch bg-[#1e1e1e] border-b border-[#2a2a2a] overflow-x-auto">
      {files.map((f) => {
        const isActive = f.id === activeId;
        return (
          <div
            key={f.id}
            className={`group flex cursor-pointer items-center gap-2 border-r border-[#2a2a2a] px-3 text-[13px] ${
              isActive
                ? "bg-[#1e1e1e] text-white border-t-2 border-t-[#0078d4] -mt-px"
                : "bg-[#2d2d2d] text-[#969696] hover:text-white"
            }`}
            onClick={() => onSelect(f.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(f.id);
              }
            }}
          >
            <span className="truncate max-w-[160px]">{f.name}</span>
            <button
              className="flex h-4 w-4 items-center justify-center rounded-sm hover:bg-[#ffffff1a]"
              onClick={(e) => {
                e.stopPropagation();
                onClose(f.id);
              }}
            >
              {f.dirty ? (
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
