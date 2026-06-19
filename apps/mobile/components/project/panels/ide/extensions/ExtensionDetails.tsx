import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { AlertTriangle, Download, ExternalLink, Play, Power, PowerOff, ShieldCheck, Star, Trash2 } from "lucide-react-native";
import { CodiconExtensions } from "../icons";
import type { ExtensionSearchResult, ExtensionUsableEntryPoint, InstalledExtension } from "./types";
import { getEntryPointActionLabel, getEntryPointKindLabel } from "./entryPoints";

type DetailTab = "details" | "features" | "changelog" | "dependencies";

export function ExtensionDetails({
  item,
  installedItem,
  installing,
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
  onRunCommand,
  onUseEntryPoint,
}: {
  item: InstalledExtension | ExtensionSearchResult;
  installedItem?: InstalledExtension;
  installing?: boolean;
  onInstall?: () => void;
  onEnable?: () => void;
  onDisable?: () => void;
  onUninstall?: () => void;
  onRunCommand?: (commandId: string) => void;
  onUseEntryPoint?: (entryPoint: ExtensionUsableEntryPoint) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("details");
  const installed = installedItem;
  const manifest = installedItem?.manifest ?? ("manifest" in item ? item.manifest : undefined);
  const commands = manifest?.contributes?.commands ?? [];
  const views = manifest?.contributes?.views ?? {};
  const viewContainers = manifest?.contributes?.viewsContainers;
  const displayName = item.displayName || item.name;
  const iconUrl = installedItem?.iconUrl ?? ("iconUrl" in item ? item.iconUrl : undefined);
  const rating = "rating" in item ? item.rating : undefined;
  const downloads = "downloads" in item ? item.downloads : undefined;
  const categories = "categories" in item ? item.categories : item.manifest.categories ?? [];
  const marketplaceUrl = `https://open-vsx.org/extension/${item.publisher}/${item.name}`;
  const canUseEntryPoints = installed?.supportStatus === "supported" || installed?.supportStatus === "partial";
  const usableEntryPoints = canUseEntryPoints ? installed?.usableEntryPoints ?? [] : [];
  const primaryEntryPoint = usableEntryPoints[0];
  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: "details", label: "Details" },
    { id: "features", label: "Features" },
    { id: "changelog", label: "Changelog" },
    { id: "dependencies", label: "Dependencies" },
  ];

  const featureRows = useMemo(() => {
    const rows: Array<{ label: string; value: string }> = [];
    if (commands.length) rows.push({ label: "Commands", value: String(commands.length) });
    const viewCount = Object.values(views).reduce((sum, group) => sum + group.length, 0);
    if (viewCount) rows.push({ label: "Views", value: String(viewCount) });
    if (viewContainers?.activitybar?.length) rows.push({ label: "Activity Bar Containers", value: String(viewContainers.activitybar.length) });
    if (viewContainers?.panel?.length) rows.push({ label: "Panel Containers", value: String(viewContainers.panel.length) });
    return rows;
  }, [commands.length, views, viewContainers]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--ide-bg)] text-[12px] text-[color:var(--ide-text)]">
      <div className="flex min-h-0 flex-1 overflow-auto">
        <main className="min-w-0 flex-1 p-5">
          <div className="flex items-start gap-4">
            <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-[color:var(--ide-panel)] text-[color:var(--ide-muted)]">
              {iconUrl ? <img src={iconUrl} alt="" className="h-full w-full object-contain" /> : <CodiconExtensions size={44} />}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[24px] font-semibold text-[color:var(--ide-text-strong)]">{displayName}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[color:var(--ide-muted)]">
                <span>{item.publisher}</span>
                <span>v{item.version}</span>
                {typeof downloads === "number" && <span>{formatDownloads(downloads)} installs</span>}
                {typeof rating === "number" && <span className="inline-flex items-center gap-1"><Star size={12} color="#fbbf24" /> {rating.toFixed(1).replace(/\.0$/, "")}</span>}
                {installed && <Badge>{installed.enabled ? "Enabled" : "Disabled"}</Badge>}
                {installed?.trustedPublisher && <Badge><ShieldCheck size={10} /> Trusted Publisher</Badge>}
                {installed?.disabledByRestrictedMode && <Badge>Restricted Mode Blocked</Badge>}
                {installed?.restrictedMode && installed.restrictedModeSupport === "limited" && <Badge>Limited in Restricted Mode</Badge>}
                {installed?.autoUpdate && <Badge>Auto Update</Badge>}
                {installed && <SupportBadge status={installed.supportStatus} />}
              </div>
              <p className="mt-3 max-w-3xl leading-relaxed text-[13px] text-[color:var(--ide-text)]">{item.description || "No description provided."}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {installed ? (
                  <>
                    {primaryEntryPoint && installed.enabled && (
                      <ActionButton onClick={() => onUseEntryPoint?.(primaryEntryPoint)} tone="primary"><Play size={13} /> Use</ActionButton>
                    )}
                    {installed.enabled ? (
                      <ActionButton onClick={onDisable} tone="secondary"><PowerOff size={13} /> Disable</ActionButton>
                    ) : (
                      <ActionButton onClick={onEnable} tone="primary"><Power size={13} /> Enable</ActionButton>
                    )}
                    <ActionButton onClick={onUninstall} tone="danger"><Trash2 size={13} /> Uninstall</ActionButton>
                    <ActionButton tone="secondary">Auto Update: {installed.autoUpdate ? "On" : "Off"}</ActionButton>
                  </>
                ) : (
                  <ActionButton onClick={onInstall} tone="primary" disabled={installing}><Download size={13} /> {installing ? "Installing…" : "Install"}</ActionButton>
                )}
              </div>
            </div>
          </div>

          <div className="mt-5 flex border-b border-[color:var(--ide-border)]">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                onClick={() => setTab(entry.id)}
                className={`border-b-2 px-3 py-2 text-[12px] ${tab === entry.id ? "border-[color:var(--ide-accent)] text-[color:var(--ide-text-strong)]" : "border-transparent text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"}`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {installed && !installed.compatible && (
            <Warning>{installed.compatibilityReason ?? "This extension targets a newer VS Code API than Shogo currently supports."}</Warning>
          )}
          {installed && installed.warnings.length > 0 && (
            <Warning>{installed.warnings.join(" ")}</Warning>
          )}
          {installed?.disabledByRestrictedMode && (
            <Warning>{installed.restrictedModeReason ?? "This extension is blocked because the current workspace is untrusted."}</Warning>
          )}
          {installed && installed.supportStatus !== "supported" && (
            <Warning>{installed.unsupportedSurfaceMessage ?? installed.supportStatusMessage}</Warning>
          )}
          {!installed && (
            <div className="mt-4 flex items-start gap-2 rounded border border-sky-500/30 bg-sky-500/10 p-3 text-[12px] text-sky-100">
              <ShieldCheck size={15} />
              <span>Shogo will ask you to trust this publisher before first install. If extension package verification fails, install is blocked and shown here as a security warning.</span>
            </div>
          )}

          {tab === "details" && (
            <>
              {installed && (
                <Section title="How to use">
                  {usableEntryPoints.length > 0 ? (
                    <div className="space-y-1">
                      {usableEntryPoints.map((entryPoint) => (
                        <button
                          key={`${entryPoint.kind}:${entryPoint.id}`}
                          onClick={() => onUseEntryPoint?.(entryPoint)}
                          disabled={!installed.enabled}
                          className="flex w-full items-center justify-between gap-2 rounded bg-[color:var(--ide-panel)] px-2 py-1.5 text-left text-[12px] hover:bg-[color:var(--ide-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-[color:var(--ide-text-strong)]">{getEntryPointActionLabel(entryPoint)}</span>
                            <span className="block truncate text-[10px] text-[color:var(--ide-muted)]">{getEntryPointKindLabel(entryPoint)}{entryPoint.detail ? ` · ${entryPoint.detail}` : ""}</span>
                          </span>
                          <Play size={12} className="shrink-0" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty>{installed.supportStatusMessage}</Empty>
                  )}
                </Section>
              )}
              <Section title="Overview">
                <p className="leading-relaxed">{item.description || "This extension has not published a detailed overview."}</p>
              </Section>
            </>
          )}

          {tab === "features" && (
            <Section title="Contributions">
              {featureRows.length === 0 ? (
                <Empty>This extension has not declared commands, views, or view containers that Shogo can render yet.</Empty>
              ) : (
                <div className="grid max-w-xl grid-cols-[180px_1fr] gap-y-2 text-[12px]">
                  {featureRows.map((row) => <MetaRow key={row.label} label={row.label}>{row.value}</MetaRow>)}
                </div>
              )}
              {installed && commands.length > 0 && (
                <div className="mt-4 space-y-1">
                  {commands.map((command) => (
                    <div key={command.command} className="flex items-center justify-between gap-2 rounded bg-[color:var(--ide-panel)] px-2 py-1.5">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-[color:var(--ide-text-strong)]">{command.category ? `${command.category}: ` : ""}{command.title}</div>
                        <div className="truncate text-[10px] text-[color:var(--ide-muted)]">{command.command}</div>
                      </div>
                      <button
                        onClick={() => canUseEntryPoints ? onRunCommand?.(command.command) : undefined}
                        disabled={!canUseEntryPoints}
                        title={canUseEntryPoints ? "Run command" : installed.supportStatusMessage}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-[color:var(--ide-border)] px-2 py-1 text-[10px] text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Play size={11} /> {canUseEntryPoints ? "Run" : "Needs runtime"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {tab === "changelog" && (
            <Section title="Changelog">
              <Empty>No changelog has been loaded for this extension yet.</Empty>
            </Section>
          )}

          {tab === "dependencies" && (
            <Section title="Dependencies">
              <Empty>{manifest?.activationEvents?.length ? `Activation events: ${manifest.activationEvents.join(", ")}` : "No extension dependencies are declared in the loaded manifest summary."}</Empty>
            </Section>
          )}
        </main>

        <aside className="hidden w-72 shrink-0 border-l border-[color:var(--ide-border)] bg-[color:var(--ide-surface)] p-4 text-[11px] lg:block">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">Marketplace</h3>
          <div className="grid grid-cols-[92px_1fr] gap-y-2">
            <MetaRow label="Identifier">{item.id}</MetaRow>
            <MetaRow label="Version">{item.version}</MetaRow>
            <MetaRow label="Publisher">{item.publisher}</MetaRow>
            {installed?.trustedPublisher && <MetaRow label="Trust">Trusted publisher{installed.trustedPublisherAt ? ` since ${formatDate(installed.trustedPublisherAt)}` : ""}</MetaRow>}
            {installed && <MetaRow label="Workspace">{installed.workspaceTrusted ? "Trusted" : "Restricted Mode"}</MetaRow>}
            {installed && <MetaRow label="Restricted">{installed.restrictedModeSupport}</MetaRow>}
            {installed && <MetaRow label="Installed">{formatDate(installed.installedAt)}</MetaRow>}
            {installed && <MetaRow label="Updated">{formatDate(installed.updatedAt)}</MetaRow>}
            {categories.length > 0 && <MetaRow label="Categories">{categories.join(", ")}</MetaRow>}
            {installed && <MetaRow label="Source">{installed.source}</MetaRow>}
            {installed && <MetaRow label="Support">{installed.supportStatusMessage}</MetaRow>}
            {installed?.capabilityKinds.length ? <MetaRow label="Capabilities">{installed.capabilityKinds.join(", ")}</MetaRow> : null}
          </div>
          <h3 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">Resources</h3>
          <ResourceLink href={marketplaceUrl}>Marketplace</ResourceLink>
          <ResourceLink href={`${marketplaceUrl}/repository`}>Repository</ResourceLink>
          <ResourceLink href={`${marketplaceUrl}/issues`}>Issues</ResourceLink>
          <ResourceLink href={`${marketplaceUrl}/license`}>License</ResourceLink>
        </aside>
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

function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-100">
      <AlertTriangle size={15} />
      <span>{children}</span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded bg-[color:var(--ide-panel)] p-3 text-[color:var(--ide-muted)]">{children}</div>;
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded bg-[color:var(--ide-panel)] px-1.5 py-0.5 text-[10px] text-[color:var(--ide-text)]">{children}</span>;
}

function SupportBadge({ status }: { status: InstalledExtension["supportStatus"] }) {
  const label = status === "supported" ? "Supported" : status === "partial" ? "Partial support" : status === "requiresRuntime" ? "Needs runtime" : "Unsupported";
  const cls = status === "supported"
    ? "bg-emerald-500/10 text-emerald-200"
    : status === "partial"
      ? "bg-sky-500/10 text-sky-200"
      : "bg-amber-500/10 text-amber-200";
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${cls}`}>{status !== "supported" && <AlertTriangle size={10} />}{label}</span>;
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return <><span className="text-[color:var(--ide-muted)]">{label}</span><span className="min-w-0 break-words text-[color:var(--ide-text)]">{children}</span></>;
}

function ResourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-1 text-[color:var(--ide-accent)] hover:underline">
      {children} <ExternalLink size={10} />
    </a>
  );
}

function formatDownloads(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

function formatDate(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
