import { Files, Search, Settings, Terminal as TerminalIcon } from "lucide-react-native";
import type { ActivityId } from "./types";

const ITEMS: { id: ActivityId; icon: React.ComponentType<{ size?: number }>; label: string; hint?: string }[] = [
  { id: "files", icon: Files, label: "Explorer", hint: "⌘⇧E" },
  { id: "search", icon: Search, label: "Search", hint: "⌘⇧F" },
];

/**
 * VS Code / Cursor-parity Activity Bar.
 *
 * Click behaviour:
 *  - clicking an inactive item selects it AND opens the sidebar if collapsed
 *  - clicking the currently-active item toggles the sidebar closed
 *    (same as VS Code — the primary way to hide the file tree)
 *  - Terminal button at the bottom toggles the bottom panel (⌃`)
 */
export function ActivityBar({
  active,
  sidebarOpen,
  terminalOpen,
  onSelect,
  onToggleSidebar,
  onToggleTerminal,
}: {
  active: ActivityId;
  sidebarOpen: boolean;
  terminalOpen: boolean;
  onSelect: (id: ActivityId) => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
}) {
  const handleSelect = (id: ActivityId) => {
    if (active === id && sidebarOpen) {
      onToggleSidebar();
    } else {
      onSelect(id);
    }
  };

  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center justify-between bg-[color:var(--ide-panel)] border-r border-[color:var(--ide-border)] py-2">
      <div className="flex flex-col items-center gap-1">
        {ITEMS.map(({ id, icon: Icon, label, hint }) => {
          const isActive = active === id && sidebarOpen;
          return (
            <button
              key={id}
              title={hint ? `${label}  (${hint})` : label}
              onClick={() => handleSelect(id)}
              className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                isActive
                  ? "text-[color:var(--ide-text-strong)]"
                  : "text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 h-6 -translate-y-1/2 w-0.5 bg-[color:var(--ide-text-strong)] rounded-r" />
              )}
              <Icon size={20} />
            </button>
          );
        })}
      </div>
      <div className="flex flex-col items-center gap-1">
        <button
          title="Terminal  (⌘J)"
          onClick={onToggleTerminal}
          className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
            terminalOpen
              ? "text-[color:var(--ide-text-strong)]"
              : "text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
          }`}
        >
          {terminalOpen && (
            <span className="absolute left-0 top-1/2 h-6 -translate-y-1/2 w-0.5 bg-[color:var(--ide-text-strong)] rounded-r" />
          )}
          <TerminalIcon size={20} />
        </button>
        <button
          title="Settings"
          onClick={() => handleSelect("settings")}
          className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
            active === "settings" && sidebarOpen
              ? "text-[color:var(--ide-text-strong)]"
              : "text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
          }`}
        >
          <Settings size={20} />
        </button>
      </div>
    </div>
  );
}
