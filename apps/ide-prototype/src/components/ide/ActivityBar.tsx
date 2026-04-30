import { useSyncExternalStore } from "react";
import { Files, Search, GitBranch, Settings, Sparkles } from "lucide-react";
import type { ActivityId } from "./types";
import { proposalStore } from "./workspace/proposalStore";

const ITEMS: { id: ActivityId; icon: React.ComponentType<{ size?: number }>; label: string }[] = [
  { id: "files", icon: Files, label: "Explorer" },
  { id: "search", icon: Search, label: "Search" },
  { id: "proposals", icon: Sparkles, label: "Proposals" },
  { id: "git", icon: GitBranch, label: "Source Control" },
];

function subscribe(fn: () => void) {
  return proposalStore.subscribe(fn);
}
function getCount() {
  return proposalStore.pendingCount();
}

export function ActivityBar({
  active,
  onSelect,
}: {
  active: ActivityId;
  onSelect: (id: ActivityId) => void;
}) {
  const pendingProposals = useSyncExternalStore(subscribe, getCount, getCount);

  return (
    <div className="flex h-full w-12 flex-col items-center justify-between bg-[#1a1a1a] border-r border-[#2a2a2a] py-2">
      <div className="flex flex-col items-center gap-1">
        {ITEMS.map(({ id, icon: Icon, label }) => {
          const isActive = active === id;
          const badge = id === "proposals" && pendingProposals > 0 ? pendingProposals : null;
          return (
            <button
              key={id}
              title={badge ? `${label} (${badge} pending)` : label}
              onClick={() => onSelect(id)}
              className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                isActive
                  ? "text-white"
                  : "text-[#858585] hover:text-white"
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 h-6 -translate-y-1/2 w-0.5 bg-white rounded-r" />
              )}
              <Icon size={20} />
              {badge !== null && (
                <span className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-amber-500 px-1 text-[9px] font-bold leading-[16px] text-black text-center">
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button
        title="Settings"
        onClick={() => onSelect("settings")}
        className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
          active === "settings" ? "text-white" : "text-[#858585] hover:text-white"
        }`}
      >
        <Settings size={20} />
      </button>
    </div>
  );
}
