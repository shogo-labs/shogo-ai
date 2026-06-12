import type { ReactNode } from "react";
import { ArrowLeft, AlertTriangle, Download, Play, Power, PowerOff, Star, Trash2 } from "lucide-react-native";
import { CodiconExtensions } from "../icons";
import type { ExtensionSearchResult, InstalledExtension } from "./types";

export function ExtensionDetails({
  item,
  installedItem,
  installing,
  onBack,
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
  onRunCommand,
}: {
  item: InstalledExtension | ExtensionSearchResult;
  installedItem?: InstalledExtension;
  installing?: boolean;
  onBack: () => void;
  onInstall?: () => void;
  onEnable?: () => void;
  onDisable?: () => void;
  onUninstall?: () => void;
  onRunCommand?: (commandId: string) => void;
}) {
  const installed = installedItem ?? ("manifest" in item ? item : undefined);
  const commands = installed?.manifest.contributes?.commands ?? [];
  const displayName = item.displayName || item.name;
  const iconUrl = "iconUrl" in item ? item.iconUrl : undefined;
  const rating = "rating" in item ? item.rating : undefined;
  const downloads = "downloads" in item ? item.downloads : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[color:var(--ide-border)] px-3 py-2">
        <button onClick={onBack} className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]">
          <ArrowLeft size={14} />
        </button>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">Extension Details</span>
      </div>
      <div className="flex-1 overflow-auto p-4 text-[12px] text-[color:var(--ide-text)]">
        <div className="flex items-start gap-3">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-[color:var(--ide-panel)] text-[color:var(--ide-muted)]">
            {iconUrl ? <img src={iconUrl} alt="" className="h-full w-full object-contain" /> : <CodiconExtensions size={34} />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[18px] font-semibold text-[color:var(--ide-text-strong)]">{displayName}</h3>
            <div className="mt-0.5 text-[11px] text-[color:var(--ide-muted)]">
              {item.publisher} · v{item.version}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[color:var(--ide-muted)]">
              {typeof downloads === "number" && <span>{formatDownloads(downloads)} downloads</span>}
              {typeof rating === "number" && <span className="inline-flex items-center gap-1"><Star size={11} color="#fbbf24" /> {rating.toFixed(1).replace(/\.0$/, "")}</span>}
              {installed && <span>{installed.enabled ? "Enabled" : "Disabled"}</span>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {installed ? (
                <>
                  {installed.enabled ? (
                    <ActionButton onClick={onDisable} tone="secondary"><PowerOff size={12} /> Disable</ActionButton>
                  ) : (
                    <ActionButton onClick={onEnable} tone="primary"><Power size={12} /> Enable</ActionButton>
                  )}
                  <ActionButton onClick={onUninstall} tone="danger"><Trash2 size={12} /> Uninstall</ActionButton>
                </>
              ) : (
                <ActionButton onClick={onInstall} tone="primary" disabled={installing}><Download size={12} /> {installing ? "Installing…" : "Install"}</ActionButton>
              )}
            </div>
            {installed && !installed.compatible && (
              <div className="mt-3 flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                <AlertTriangle size={13} />
                <span>{installed.compatibilityReason ?? "This extension targets a newer VS Code API than Shogo currently supports."}</span>
              </div>
            )}
          </div>
        </div>

        {item.description && <p className="mt-4 leading-relaxed">{item.description}</p>}

        {installed?.restartRequired && (
          <div className="mt-4 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-100">
            Restart extensions to apply the latest install, uninstall, enable, or disable change.
          </div>
        )}

        {installed && installed.warnings.length > 0 && (
          <Section title="Warnings">
            <ul className="list-disc space-y-1 pl-4">
              {installed.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </Section>
        )}

        {installed && (
          <Section title="Use This Extension">
            {commands.length > 0 ? (
              <div className="space-y-1">
                {commands.map((command) => (
                  <div key={command.command} className="flex items-center justify-between gap-2 rounded bg-[color:var(--ide-panel)] px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[color:var(--ide-text-strong)]">{command.category ? `${command.category}: ` : ""}{command.title}</div>
                      <div className="truncate text-[10px] text-[color:var(--ide-muted)]">{command.command}</div>
                    </div>
                    <button
                      onClick={() => onRunCommand?.(command.command)}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-[color:var(--ide-border)] px-2 py-1 text-[10px] text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-hover)]"
                    >
                      <Play size={11} /> Run
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded bg-[color:var(--ide-panel)] p-2 text-[color:var(--ide-muted)]">
                This extension does not expose command-palette commands. It may require VS Code APIs Shogo has not implemented yet, such as Webviews, SCM providers, Debuggers, Tasks, or Language Server integrations.
              </div>
            )}
          </Section>
        )}

        <Section title="Marketplace">
          <div className="grid grid-cols-[88px_1fr] gap-y-1 text-[11px]">
            <span className="text-[color:var(--ide-muted)]">Identifier</span><span>{item.id}</span>
            <span className="text-[color:var(--ide-muted)]">Version</span><span>{item.version}</span>
            <span className="text-[color:var(--ide-muted)]">Publisher</span><span>{item.publisher}</span>
            {"categories" in item && item.categories.length > 0 && <><span className="text-[color:var(--ide-muted)]">Categories</span><span>{item.categories.join(", ")}</span></>}
          </div>
        </Section>
      </div>
    </div>
  );
}

function ActionButton({ children, onClick, tone, disabled }: { children: ReactNode; onClick?: () => void; tone: "primary" | "secondary" | "danger"; disabled?: boolean }) {
  const cls = tone === "primary"
    ? "bg-[color:var(--ide-accent)] text-white"
    : tone === "danger"
      ? "border border-red-500/40 text-red-100 hover:bg-red-500/10"
      : "border border-[color:var(--ide-border)] text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-hover)]";
  return (
    <button onClick={onClick} disabled={disabled} className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${cls}`}>
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">{title}</h4>
      {children}
    </section>
  );
}

function formatDownloads(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}
