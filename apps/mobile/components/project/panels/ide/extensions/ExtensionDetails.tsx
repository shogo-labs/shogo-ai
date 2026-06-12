import type { ReactNode } from "react";
import { ArrowLeft, AlertTriangle, Package } from "lucide-react-native";
import type { ExtensionSearchResult, InstalledExtension } from "./types";

export function ExtensionDetails({ item, onBack }: { item: InstalledExtension | ExtensionSearchResult; onBack: () => void }) {
  const installed = "manifest" in item;
  const commands = installed ? item.manifest.contributes?.commands ?? [] : [];
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
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-[color:var(--ide-panel)] text-[color:var(--ide-muted)]">
            {"iconUrl" in item && item.iconUrl ? <img src={item.iconUrl} alt="" className="h-full w-full rounded object-cover" /> : <Package size={24} />}
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[16px] font-semibold text-[color:var(--ide-text-strong)]">{item.displayName || item.name}</h3>
            <div className="mt-0.5 text-[11px] text-[color:var(--ide-muted)]">{item.publisher} · v{item.version}</div>
            {installed && !item.compatible && (
              <div className="mt-2 flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                <AlertTriangle size={13} />
                <span>{item.compatibilityReason ?? "This extension targets a newer VS Code API than Shogo currently supports."}</span>
              </div>
            )}
          </div>
        </div>
        {item.description && <p className="mt-4 leading-relaxed">{item.description}</p>}
        {installed && item.warnings.length > 0 && (
          <Section title="Warnings">
            <ul className="list-disc space-y-1 pl-4">
              {item.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </Section>
        )}
        {installed && (
          <Section title="Contributions">
            {commands.length > 0 ? (
              <div className="space-y-1">
                {commands.map((command) => (
                  <div key={command.command} className="rounded bg-[color:var(--ide-panel)] px-2 py-1">
                    <div className="font-medium text-[color:var(--ide-text-strong)]">{command.title}</div>
                    <div className="text-[10px] text-[color:var(--ide-muted)]">{command.command}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[color:var(--ide-muted)]">No command contributions declared.</div>
            )}
          </Section>
        )}
      </div>
    </div>
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
