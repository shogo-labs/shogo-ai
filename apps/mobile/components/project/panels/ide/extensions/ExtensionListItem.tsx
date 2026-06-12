import type { ReactNode } from "react";
import { CheckCircle2, Download, Package, Power, PowerOff, Trash2, XCircle } from "lucide-react-native";
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
      <button onClick={onSelect} className="flex w-full items-start gap-2 text-left">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[color:var(--ide-panel)] text-[color:var(--ide-muted)]">
          <Package size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-[color:var(--ide-text-strong)]">
            {extension.displayName ?? extension.name}
          </div>
          <div className="truncate text-[10px] text-[color:var(--ide-muted)]">
            {extension.publisher} · v{extension.version}
          </div>
          {extension.description && (
            <div className="mt-1 line-clamp-2 text-[11px] text-[color:var(--ide-text)]">
              {extension.description}
            </div>
          )}
        </div>
      </button>
      <div className="mt-2 flex items-center justify-between gap-2 pl-10">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${extension.enabled ? "text-emerald-300" : "text-[color:var(--ide-muted)]"}`}>
          {extension.enabled ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
          {extension.enabled ? "Enabled" : "Disabled"}
        </span>
        <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100">
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
  onInstall,
  onSelect,
}: {
  result: ExtensionSearchResult;
  onInstall: () => void;
  onSelect: () => void;
}) {
  return (
    <div className="group border-b border-[color:var(--ide-border)] px-3 py-2 hover:bg-[color:var(--ide-hover-subtle)]">
      <button onClick={onSelect} className="flex w-full items-start gap-2 text-left">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-[color:var(--ide-panel)] text-[color:var(--ide-muted)]">
          {result.iconUrl ? <img src={result.iconUrl} alt="" className="h-full w-full object-cover" /> : <Package size={16} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-[color:var(--ide-text-strong)]">{result.displayName || result.name}</div>
          <div className="truncate text-[10px] text-[color:var(--ide-muted)]">{result.publisher} · v{result.version}</div>
          {result.description && <div className="mt-1 line-clamp-2 text-[11px] text-[color:var(--ide-text)]">{result.description}</div>}
        </div>
      </button>
      <div className="mt-2 flex justify-end pl-10">
        <button onClick={onInstall} className="inline-flex items-center gap-1 rounded bg-[color:var(--ide-accent)] px-2 py-1 text-[10px] font-semibold text-white hover:opacity-90">
          <Download size={11} /> Install
        </button>
      </div>
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
