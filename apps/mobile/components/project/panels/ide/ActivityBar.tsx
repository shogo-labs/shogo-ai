import { Files, GitCommit, Search, Settings, Terminal as TerminalIcon } from "lucide-react-native";
import { CodiconSourceControl, CodiconRunDebug, CodiconExtensions } from "./icons";
import type { ActivityId } from "./types";
import { formatBadgeCount, type BadgeData, type BadgeTone } from "./badges/formatBadge";

const ITEMS: { id: ActivityId; icon: React.ComponentType<{ size?: number }>; label: string; hint?: string }[] = [
  { id: "files",      icon: Files,                label: "Explorer",       hint: "⌘⇧E" },
  { id: "search",     icon: Search,               label: "Search",         hint: "⌘⇧F" },
  { id: "git",        icon: CodiconSourceControl, label: "Source Control", hint: "⌃⇧G" },
  { id: "debug",      icon: CodiconRunDebug,      label: "Run and Debug",  hint: "⇧⌘D" },
  { id: "extensions", icon: CodiconExtensions,    label: "Extensions",     hint: "⇧⌘X" },
  { id: "checkpoint", icon: GitCommit,            label: "Checkpoint" },
];

const BADGE_TONE_BG: Record<BadgeTone, string> = {
  neutral: "bg-orange-500 text-white",
  warn:    "bg-amber-500 text-zinc-900",
  error:   "bg-red-500 text-white",
};

function ActivityBadgePill({ data }: { data: BadgeData }) {
  const label = formatBadgeCount(data.count);
  if (!label) return null;
  const tone = data.tone ?? "neutral";
  return (
    <span
      aria-label={`${label} ${tone === "error" ? "errors" : tone === "warn" ? "warnings" : "items"}`}
      className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-[3px] rounded-full text-[10px] font-semibold leading-[16px] text-center ide-mono ${BADGE_TONE_BG[tone]} ring-2 ring-[color:var(--ide-panel)] pointer-events-none`}
    >
      {label}
    </span>
  );
}

export function ActivityBar({
  active,
  sidebarOpen,
  terminalOpen,
  badges = null,
  onSelect,
  onToggleSidebar,
  onToggleTerminal,
  hiddenItemIds,
}: {
  active: ActivityId;
  sidebarOpen: boolean;
  terminalOpen: boolean;
  badges?: Partial<Record<ActivityId, BadgeData>> | null;
  onSelect: (id: ActivityId) => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  hiddenItemIds?: ActivityId[];
}) {
  const handleSelect = (id: ActivityId) => {
    if (active === id && sidebarOpen) {
      onToggleSidebar();
    } else {
      onSelect(id);
    }
  };

  const badgeFor = (id: ActivityId): BadgeData | undefined => badges?.[id];

  const visibleItems = hiddenItemIds && hiddenItemIds.length > 0
    ? ITEMS.filter(({ id }) => !hiddenItemIds.includes(id))
    : ITEMS;

  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center justify-between bg-[color:var(--ide-panel)] border-l border-[color:var(--ide-border)] py-2">
      <div className="flex flex-col items-center gap-1">
        {visibleItems.map(({ id, icon: Icon, label, hint }) => {
          const isActive = active === id && sidebarOpen;
          const badge = badgeFor(id);
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
                <span className="absolute right-0 top-1/2 h-6 -translate-y-1/2 w-0.5 bg-[color:var(--ide-text-strong)] rounded-l" />
              )}
              <Icon size={20} />
              {badge && <ActivityBadgePill data={badge} />}
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
            <span className="absolute right-0 top-1/2 h-6 -translate-y-1/2 w-0.5 bg-[color:var(--ide-text-strong)] rounded-l" />
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
