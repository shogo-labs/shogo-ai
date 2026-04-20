import { Files, Search, Settings } from "lucide-react-native";
import type { ActivityId } from "./types";

const ITEMS: { id: ActivityId; icon: React.ComponentType<{ size?: number }>; label: string }[] = [
  { id: "files", icon: Files, label: "Explorer" },
  { id: "search", icon: Search, label: "Search" },
];

export function ActivityBar({
  active,
  onSelect,
}: {
  active: ActivityId;
  onSelect: (id: ActivityId) => void;
}) {
  return (
    <div className="flex h-full w-12 flex-col items-center justify-between bg-[#1a1a1a] border-r border-[#2a2a2a] py-2">
      <div className="flex flex-col items-center gap-1">
        {ITEMS.map(({ id, icon: Icon, label }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              title={label}
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
