import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Filter, Plus, RefreshCw, Search } from "lucide-react-native";
import type { ExtensionViewContainerContribution, InstalledExtension } from "./types";

export interface ExtensionRuntimeContainer {
  activityId: `extension:${string}`;
  id: string;
  title: string;
  icon?: string;
  location: "activitybar" | "panel";
  extension: InstalledExtension;
}

export function collectRuntimeContainers(extensions: InstalledExtension[]): ExtensionRuntimeContainer[] {
  return extensions.flatMap((extension) => {
    if (!extension.enabled || !extension.compatible) return [];
    const containers: ExtensionRuntimeContainer[] = [];
    for (const container of extension.manifest.contributes?.viewsContainers?.activitybar ?? []) {
      containers.push(toRuntimeContainer(extension, container, "activitybar"));
    }
    for (const container of extension.manifest.contributes?.viewsContainers?.panel ?? []) {
      containers.push(toRuntimeContainer(extension, container, "panel"));
    }
    return containers;
  });
}

function toRuntimeContainer(
  extension: InstalledExtension,
  container: ExtensionViewContainerContribution,
  location: "activitybar" | "panel",
): ExtensionRuntimeContainer {
  return {
    activityId: `extension:${extension.id}:${container.id}`,
    id: container.id,
    title: container.title,
    icon: container.icon,
    location,
    extension,
  };
}

export function ExtensionRuntimeViewlet({
  container,
  onRunCommand,
  onOpenDetails,
}: {
  container: ExtensionRuntimeContainer;
  onRunCommand: (commandId: string) => void;
  onOpenDetails: (extension: InstalledExtension) => void;
}) {
  const views = container.extension.manifest.contributes?.views?.[container.id] ?? [];
  const commands = container.extension.manifest.contributes?.commands ?? [];
  const viewTitleCommands = container.extension.manifest.contributes?.menus?.["view/title"] ?? [];

  return (
    <div className="flex h-full flex-col bg-[color:var(--ide-surface)] text-[12px] text-[color:var(--ide-text)]">
      <div className="flex h-9 items-center gap-2 border-b border-[color:var(--ide-border)] px-3">
        <div className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
          {container.title}
        </div>
        <ToolbarButton title="Refresh"><RefreshCw size={13} /></ToolbarButton>
        <ToolbarButton title="Search"><Search size={13} /></ToolbarButton>
        <ToolbarButton title="Filter"><Filter size={13} /></ToolbarButton>
        <ToolbarButton title="New"><Plus size={13} /></ToolbarButton>
      </div>

      <div className="border-b border-[color:var(--ide-border)] px-3 py-2 text-[11px] text-[color:var(--ide-muted)]">
        <div className="truncate text-[color:var(--ide-text)]">{container.extension.displayName || container.extension.name}</div>
        <div className="mt-1 flex items-center gap-2">
          <span>{container.location === "panel" ? "Panel container" : "Activity Bar container"}</span>
          <button onClick={() => onOpenDetails(container.extension)} className="inline-flex items-center gap-1 text-[color:var(--ide-accent)] hover:underline">
            Details <ExternalLink size={10} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {views.length === 0 ? (
          <WelcomeView>
            This extension contributes the “{container.title}” container but has not registered any visible views under it yet.
          </WelcomeView>
        ) : (
          views.map((view) => {
            const activeViewCommands = viewTitleCommands.filter((item) => !item.when || item.when.includes(`view == ${view.id}`) || item.when.includes(`view == '${view.id}'`));
            return (
              <section key={view.id} className="border-b border-[color:var(--ide-border)]">
                <div className="flex h-8 items-center gap-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
                  <ChevronDown size={13} />
                  <span className="min-w-0 flex-1 truncate">{view.name}</span>
                  {activeViewCommands.slice(0, 3).map((item) => {
                    const command = commands.find((candidate) => candidate.command === item.command);
                    return (
                      <ToolbarButton key={item.command} title={command?.title ?? item.command} onClick={() => onRunCommand(item.command)}>
                        <RefreshCw size={12} />
                      </ToolbarButton>
                    );
                  })}
                </div>
                <div className="px-2 pb-2">
                  {commands.length > 0 ? (
                    <div className="space-y-0.5">
                      {commands.map((command) => (
                        <button
                          key={`${view.id}:${command.command}`}
                          onClick={() => onRunCommand(command.command)}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
                        >
                          <ChevronRight size={12} color="var(--ide-muted)" />
                          <span className="min-w-0 flex-1 truncate">{command.title}</span>
                          {command.category && <span className="truncate text-[10px] text-[color:var(--ide-muted)]">{command.category}</span>}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <WelcomeView compact>
                      {view.name} is ready. The extension has not exposed tree items through Shogo’s runtime API yet.
                    </WelcomeView>
                  )}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function ToolbarButton({ title, onClick, children }: { title: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
    >
      {children}
    </button>
  );
}

function WelcomeView({ children, compact }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className={`${compact ? "px-2 py-2" : "p-3"} text-[11px] leading-relaxed text-[color:var(--ide-muted)]`}>
      {children}
    </div>
  );
}
