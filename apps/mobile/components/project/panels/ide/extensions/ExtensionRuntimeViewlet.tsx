import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Filter, Plus, RefreshCw, Search } from "lucide-react-native";
import type { ExtensionRuntimeTreeItem, ExtensionRuntimeViewResult, ExtensionViewContainerContribution, InstalledExtension } from "./types";

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
  onLoadView,
}: {
  container: ExtensionRuntimeContainer;
  onRunCommand: (commandId: string, args?: unknown[]) => void;
  onOpenDetails: (extension: InstalledExtension) => void;
  onLoadView: (viewId: string) => Promise<ExtensionRuntimeViewResult | null>;
}) {
  const views = container.extension.manifest.contributes?.views?.[container.id] ?? [];
  const commands = container.extension.manifest.contributes?.commands ?? [];
  const viewTitleCommands = container.extension.manifest.contributes?.menus?.["view/title"] ?? [];
  const [loadedViews, setLoadedViews] = useState<Record<string, ExtensionRuntimeViewResult>>({});
  const [loadingViews, setLoadingViews] = useState<Record<string, boolean>>({});
  const [viewErrors, setViewErrors] = useState<Record<string, string>>({});

  const loadView = useCallback(async (viewId: string) => {
    setLoadingViews((prev) => ({ ...prev, [viewId]: true }));
    setViewErrors((prev) => {
      const next = { ...prev };
      delete next[viewId];
      return next;
    });
    try {
      const result = await onLoadView(viewId);
      if (result) setLoadedViews((prev) => ({ ...prev, [viewId]: result }));
    } catch (err) {
      setViewErrors((prev) => ({ ...prev, [viewId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoadingViews((prev) => ({ ...prev, [viewId]: false }));
    }
  }, [onLoadView]);

  useEffect(() => {
    for (const view of views) void loadView(view.id);
  }, [container.activityId, loadView, views]);

  const refreshViews = () => {
    for (const view of views) void loadView(view.id);
  };

  return (
    <div className="flex h-full flex-col bg-[color:var(--ide-surface)] text-[12px] text-[color:var(--ide-text)]">
      <div className="flex h-9 items-center gap-2 border-b border-[color:var(--ide-border)] px-3">
        <div className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
          {container.title}
        </div>
        <ToolbarButton title="Refresh" onClick={refreshViews}><RefreshCw size={13} /></ToolbarButton>
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
                  <RuntimeViewBody
                    items={loadedViews[view.id]?.items ?? []}
                    message={loadedViews[view.id]?.message}
                    error={viewErrors[view.id]}
                    loading={!!loadingViews[view.id]}
                    fallbackCommands={commands}
                    viewName={view.name}
                    onRunCommand={onRunCommand}
                  />
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function RuntimeViewBody({
  items,
  message,
  error,
  loading,
  fallbackCommands,
  viewName,
  onRunCommand,
}: {
  items: ExtensionRuntimeTreeItem[];
  message?: string;
  error?: string;
  loading: boolean;
  fallbackCommands: Array<{ command: string; title: string; category?: string }>;
  viewName: string;
  onRunCommand: (commandId: string, args?: unknown[]) => void;
}) {
  if (error) return <WelcomeView compact>{error}</WelcomeView>;
  if (items.length > 0) {
    return (
      <div className="space-y-0.5">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => item.command && onRunCommand(item.command.command, item.command.arguments)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)] disabled:cursor-default disabled:hover:bg-transparent"
            disabled={!item.command}
            title={item.tooltip || item.label}
          >
            <ChevronRight size={12} color="var(--ide-muted)" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.description && <span className="truncate text-[10px] text-[color:var(--ide-muted)]">{item.description}</span>}
          </button>
        ))}
      </div>
    );
  }
  if (message) return <WelcomeView compact>{message}</WelcomeView>;
  if (loading) return <WelcomeView compact>Activating {viewName}…</WelcomeView>;
  if (fallbackCommands.length > 0) {
    return (
      <div className="space-y-0.5">
        {fallbackCommands.map((command) => (
          <button
            key={`${viewName}:${command.command}`}
            onClick={() => onRunCommand(command.command)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
          >
            <ChevronRight size={12} color="var(--ide-muted)" />
            <span className="min-w-0 flex-1 truncate">{command.title}</span>
            {command.category && <span className="truncate text-[10px] text-[color:var(--ide-muted)]">{command.category}</span>}
          </button>
        ))}
      </div>
    );
  }
  return <WelcomeView compact>{viewName} activated. No tree items were returned yet.</WelcomeView>;
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
