import { useState } from "react";
import { X } from "lucide-react";

const TABS = ["Problems", "Output", "Terminal", "Agent"] as const;
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
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3 font-mono text-[12px] text-[#cccccc]">
        {tab === "Terminal" && (
          <>
            <div className="text-[#4ec9b0]">shogo@ide</div>
            <div>
              <span className="text-[#4ec9b0]">$</span> npm run dev
            </div>
            <div className="text-[#858585]">
              VITE ready — local: http://localhost:5173
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[#4ec9b0]">$</span>
              <span className="inline-block h-[14px] w-[7px] animate-pulse bg-[#cccccc]" />
            </div>
          </>
        )}
        {tab === "Problems" && (
          <div className="text-[#858585]">No problems detected in workspace.</div>
        )}
        {tab === "Output" && (
          <div className="text-[#858585]">[Vite] hmr update /src/App.tsx</div>
        )}
        {tab === "Agent" && (
          <div className="space-y-2">
            <div className="text-[#4ec9b0]">⚡ Shogo Agent — idle</div>
            <div className="text-[#858585]">
              Ready. Ask me to edit code and you'll see live diffs here.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
