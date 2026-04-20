import { useState } from "react";
import { X } from "lucide-react";
import { Terminal } from "./Terminal";

const TABS = ["Terminal", "Problems", "Output"] as const;
type TabId = (typeof TABS)[number];

export function BottomPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabId>("Terminal");

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e]">
      <div className="flex items-center justify-between border-b border-[#2a2a2a] pr-2">
        <div className="flex">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider ${
                tab === t
                  ? "text-white border-b-2 border-white"
                  : "text-[#858585] hover:text-white"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          title="Hide panel"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className={`h-full ${tab === "Terminal" ? "" : "hidden"}`}>
          <Terminal visible={tab === "Terminal"} />
        </div>
        {tab === "Problems" && (
          <div className="h-full p-3 font-mono text-[12px] text-[#858585]">
            No problems detected in workspace.
          </div>
        )}
        {tab === "Output" && (
          <div className="h-full p-3 font-mono text-[12px] text-[#858585]">
            [Vite] hmr update /src/App.tsx
          </div>
        )}
      </div>
    </div>
  );
}
