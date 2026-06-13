import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Download, Power, PowerOff, ShieldCheck, Star, Trash2, XCircle } from "lucide-react-native";
import { CodiconExtensions } from "../icons";
import type { ExtensionSearchResult, InstalledExtension } from "./types";

export function InstalledExtensionListItem({
  extension,
  onEnable,
  onDisable,
  onUninstall,
  onSelect,
}: {
  extension: InstalledExtension;
  onEnable: () => void;
  onDisable: () => void;
  onUninstall: () => void;
  onSelect: () => void;
}) {
  return (
    <div className="group border-b border-[color:var(--ide-border)] px-3 py-2 hover:bg-[color:var(--ide-hover-subtle)]">
      <button onClick={onSelect} className="flex w-full items-start gap-3 text-left">
        <ExtensionIcon iconUrl={extension.iconUrl} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[color:var(--ide-text-strong)]">
            {extension.displayName ?? extension.name}
          </div>
          <div className="flex flex-wrap items-center gap-1 text-[11px] font-semibold text-[color:var(--ide-muted)]">
            <span className="truncate">{extension.publisher}</span>
            {extension.trustedPublisher && <TrustBadge />}
            {extension.disabledByRestrictedMode && <RestrictedBadge />}
            {extension.restrictedMode && extension.restrictedModeSupport === "limited" && <LimitedRestrictedBadge />}
            {!extension.hasUsableEntryPoint && <UnsupportedSurfaceBadge />}
          </div>
          {!extension.hasUsableEntryPoint && extension.unsupportedSurfaceMessage && (
            <div className="mt-1 flex items-start gap-1 rounded border border-amber-500/20 bg-amber-500/5 px-1.5 py-1 text-[10px] leading-snug text-amber-100">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span className="line-clamp-2">{extension.unsupportedSurfaceMessage}</span>
            </div>
          )}
          {extension.description && (
            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[color:var(--ide-text)]">
              {extension.description}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right text-[10px] text-[color:var(--ide-muted)]">
          <div>v{extension.version}</div>
          {extension.restartRequired && <div className="mt-1 text-amber-300">restart</div>}
        </div>
      </button>
      <div className="mt-2 flex items-center justify-between gap-2 pl-11">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${extension.enabled ? "text-emerald-300" : "text-[color:var(--ide-muted)]"}`}>
          {extension.enabled ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
          {extension.enabled ? "Enabled" : "Disabled"}
        </span>
        <div className="flex items-center gap-1 opacity-90 group-hover:opacity-100">
          {extension.enabled ? (
            <IconButton title="Disable" onClick={onDisable}><PowerOff size={12} /></IconButton>
          ) : (
            <IconButton title="Enable" onClick={onEnable}><Power size={12} /></IconButton>
          )}
          <IconButton title="Uninstall" onClick={onUninstall}><Trash2 size={12} /></IconButton>
        </div>
      </div>
    </div>
  );
}

export function SearchExtensionListItem({
  result,
  installed,
  installing,
  publisherTrusted,
  onInstall,
  onSelect,
}: {
  result: ExtensionSearchResult;
  installed?: boolean;
  installing?: boolean;
  publisherTrusted?: boolean;
  onInstall: () => void;
  onSelect: () => void;
}) {
  return (
    <div className="group border-b border-[color:var(--ide-border)] px-3 py-2 hover:bg-[color:var(--ide-hover-subtle)]">
      <button onClick={onSelect} className="flex w-full items-start gap-3 text-left">
        <ExtensionIcon iconUrl={result.iconUrl} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[color:var(--ide-text-strong)]">{result.displayName || result.name}</div>
          <div className="flex flex-wrap items-center gap-1 text-[11px] font-semibold text-[color:var(--ide-muted)]">
            <span className="truncate">{result.verified ? "✓ " : ""}{result.publisher}</span>
            {publisherTrusted && <TrustBadge />}
          </div>
          {result.description && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[color:var(--ide-text)]">{result.description}</div>}
        </div>
        <div className="shrink-0 text-right text-[10px] text-[color:var(--ide-muted)]">
          {typeof result.downloads === "number" && <div>{formatDownloads(result.downloads)}</div>}
          {typeof result.rating === "number" && <div className="mt-1 inline-flex items-center justify-end gap-0.5"><Star size={10} color="#fbbf24" /> {result.rating.toFixed(1).replace(/\.0$/, "")}</div>}
        </div>
      </button>
      <div className="mt-2 flex justify-end pl-11">
        {installed ? (
          <span className="rounded border border-[color:var(--ide-border)] px-2 py-1 text-[10px] text-[color:var(--ide-muted)]">Installed</span>
        ) : (
          <button
            onClick={onInstall}
            disabled={installing}
            className="inline-flex items-center gap-1 rounded bg-[color:var(--ide-accent)] px-2 py-1 text-[10px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Download size={11} /> {installing ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}

function TrustBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-0.5 text-[9px] font-semibold text-emerald-200">
      <ShieldCheck size={9} /> Trusted
    </span>
  );
}

function RestrictedBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold text-amber-200">
      Restricted
    </span>
  );
}

function LimitedRestrictedBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-sky-500/30 bg-sky-500/10 px-1 py-0.5 text-[9px] font-semibold text-sky-200">
      Limited
    </span>
  );
}

function UnsupportedSurfaceBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold text-amber-200">
      <AlertTriangle size={9} /> No entry point
    </span>
  );
}

function ExtensionIcon({ iconUrl }: { iconUrl?: string }) {
  return (
    <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-[color:var(--ide-panel)] text-[color:var(--ide-muted)]">
      {iconUrl ? <img src={iconUrl} alt="" className="h-full w-full object-contain" /> : <CodiconExtensions size={22} />}
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
    >
      {children}
    </button>
  );
}

function formatDownloads(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}
