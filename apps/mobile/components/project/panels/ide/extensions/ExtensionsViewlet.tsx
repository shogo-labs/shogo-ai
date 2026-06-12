import type { ReactNode } from "react";
import { RefreshCw, Search } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ExtensionActionsMenu } from "./ExtensionActionsMenu";
import { ExtensionDetails } from "./ExtensionDetails";
import { InstalledExtensionListItem, SearchExtensionListItem } from "./ExtensionListItem";
import { useExtensions } from "./useExtensions";
import type { ExtensionSearchResult, InstalledExtension } from "./types";

export function ExtensionsViewlet({ workspaceRoot }: { workspaceRoot?: string | null }) {
  const extensions = useExtensions({ workspaceRoot });
  const [selected, setSelected] = useState<InstalledExtension | ExtensionSearchResult | null>(null);
  const installed = extensions.installed;
  const disabled = useMemo(() => installed.filter((extension) => !extension.enabled), [installed]);
  const enabled = useMemo(() => installed.filter((extension) => extension.enabled), [installed]);

  if (!extensions.available) {
    return (
      <div className="flex h-full flex-col p-4 text-[12px] text-[color:var(--ide-muted)]">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider">Extensions</h2>
        <p>Extensions are available in Shogo Desktop only.</p>
      </div>
    );
  }

  if (selected) return <ExtensionDetails item={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="flex h-full flex-col bg-[color:var(--ide-surface)]">
      <div className="flex items-center justify-between border-b border-[color:var(--ide-border)] px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">Extensions</span>
        <div className="flex items-center gap-1">
          <button title="Refresh" onClick={() => void extensions.refresh()} className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]">
            <RefreshCw size={14} />
          </button>
          <ExtensionActionsMenu
            onInstallVsix={() => void extensions.installFromVsix()}
            onCheckUpdates={() => void extensions.checkUpdates()}
            onShowRunning={() => void extensions.showRunningExtensions()}
            onStartBisect={() => void extensions.startBisect()}
          />
        </div>
      </div>

      <div className="border-b border-[color:var(--ide-border)] p-2">
        <form onSubmit={(event) => { event.preventDefault(); void extensions.runSearch(); }} className="flex items-center gap-1 rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-panel)] px-2 py-1">
          <Search size={13} className="text-[color:var(--ide-muted)]" />
          <input
            value={extensions.query}
            onChange={(event) => extensions.setQuery(event.target.value)}
            placeholder="Search Extensions in Marketplace"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[color:var(--ide-text)] outline-none placeholder:text-[color:var(--ide-muted)]"
          />
        </form>
      </div>

      {extensions.restartRequired && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
          <div>Extensions require a restart to take effect.</div>
          <button onClick={() => void extensions.restartHost()} className="mt-1 rounded bg-amber-500 px-2 py-1 font-semibold text-zinc-950 hover:opacity-90">
            Restart Extensions
          </button>
        </div>
      )}

      {extensions.error && <Banner tone="error">{extensions.error}</Banner>}
      {extensions.message && <Banner tone="info">{extensions.message}</Banner>}

      <div className="flex-1 overflow-auto">
        {extensions.results.length > 0 && (
          <Section title={`Search Results (${extensions.results.length})`}>
            {extensions.results.map((result) => (
              <SearchExtensionListItem
                key={result.id}
                result={result}
                onSelect={() => setSelected(result)}
                onInstall={() => void extensions.installFromRegistry(result.id, result.version)}
              />
            ))}
          </Section>
        )}

        <Section title={`Installed (${installed.length})`} loading={extensions.loading}>
          {enabled.length === 0 && <Empty>Install a VSIX or search Open VSX to add extensions.</Empty>}
          {enabled.map((extension) => (
            <InstalledExtensionListItem
              key={extension.id}
              extension={extension}
              onSelect={() => setSelected(extension)}
              onEnable={() => void extensions.setEnabled(extension.id, true)}
              onDisable={() => void extensions.setEnabled(extension.id, false)}
              onUninstall={() => void extensions.uninstall(extension.id)}
            />
          ))}
        </Section>

        {disabled.length > 0 && (
          <Section title={`Disabled (${disabled.length})`}>
            {disabled.map((extension) => (
              <InstalledExtensionListItem
                key={extension.id}
                extension={extension}
                onSelect={() => setSelected(extension)}
                onEnable={() => void extensions.setEnabled(extension.id, true)}
                onDisable={() => void extensions.setEnabled(extension.id, false)}
                onUninstall={() => void extensions.uninstall(extension.id)}
              />
            ))}
          </Section>
        )}

        <Section title="Recommended">
          <Empty>Workspace recommendations from .vscode/extensions.json will appear here.</Empty>
        </Section>

        <Section title="Running Extensions">
          <Empty>No extension host is running yet.</Empty>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, loading, children }: { title: string; loading?: boolean; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between border-b border-[color:var(--ide-border)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
        <span>{title}</span>
        {loading && <span>Loading…</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-3 text-[11px] text-[color:var(--ide-muted)]">{children}</div>;
}

function Banner({ tone, children }: { tone: "error" | "info"; children: ReactNode }) {
  const cls = tone === "error" ? "border-red-500/30 bg-red-500/10 text-red-100" : "border-sky-500/30 bg-sky-500/10 text-sky-100";
  return <div className={`border-b px-3 py-2 text-[11px] ${cls}`}>{children}</div>;
}
