import type { ReactNode } from "react";
import { Filter, RefreshCw, Search, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ExtensionActionsMenu } from "./ExtensionActionsMenu";
import { InstalledExtensionListItem, SearchExtensionListItem } from "./ExtensionListItem";
import { useExtensions } from "./useExtensions";
import type { ExtensionSearchResult, InstalledExtension } from "./types";

export function ExtensionsViewlet({
  workspaceRoot,
  onOpenDetails,
}: {
  workspaceRoot?: string | null;
  onOpenDetails?: (item: InstalledExtension | ExtensionSearchResult) => void;
}) {
  const extensions = useExtensions({ workspaceRoot });
  const [pendingInstall, setPendingInstall] = useState<ExtensionSearchResult | null>(null);
  const installed = extensions.installed;
  const installedIds = useMemo(() => new Set(installed.map((extension) => extension.id)), [installed]);
  const disabled = useMemo(() => installed.filter((extension) => !extension.enabled), [installed]);
  const enabled = useMemo(() => installed.filter((extension) => extension.enabled), [installed]);
  const hasQuery = extensions.query.trim().length > 0;

  if (!extensions.available) {
    return (
      <div className="flex h-full flex-col p-4 text-[12px] text-[color:var(--ide-muted)]">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider">Extensions</h2>
        <p>Extensions are available in Shogo Desktop only.</p>
      </div>
    );
  }

  const requestInstall = (result: ExtensionSearchResult) => {
    if (isPublisherTrusted(result.publisher)) {
      void extensions.installFromRegistry(result.id, result.version);
    } else {
      setPendingInstall(result);
    }
  };
  const trustAndInstall = () => {
    if (!pendingInstall) return;
    trustPublisher(pendingInstall.publisher);
    void extensions.installFromRegistry(pendingInstall.id, pendingInstall.version);
    setPendingInstall(null);
  };

  return (
    <div className="relative flex h-full flex-col bg-[color:var(--ide-surface)]">
      <div className="flex items-center justify-between border-b border-[color:var(--ide-border)] px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">Extensions</span>
        <div className="flex items-center gap-1">
          <button title="Refresh" onClick={() => { void extensions.refresh(); void extensions.runSearch(); }} className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]">
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
          <Search size={13} color="var(--ide-muted)" />
          <input
            value={extensions.query}
            onChange={(event) => extensions.setQuery(event.target.value)}
            placeholder="Search Extensions in Marketplace"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[color:var(--ide-text)] outline-none placeholder:text-[color:var(--ide-muted)]"
          />
          {extensions.query && (
            <button type="button" onClick={() => extensions.setQuery("")} className="rounded p-0.5 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]">
              <X size={13} />
            </button>
          )}
          <Filter size={13} color="var(--ide-muted)" />
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
        {hasQuery && (
          <Section title={extensions.searching ? "Search Results (searching…)" : `Search Results (${extensions.results.length})`}>
            {extensions.results.length === 0 && !extensions.searching && <Empty>No extensions found for “{extensions.query.trim()}”.</Empty>}
            {extensions.results.map((result) => (
              <SearchExtensionListItem
                key={result.id}
                result={result}
                installed={installedIds.has(result.id)}
                installing={extensions.installingId === result.id}
                onSelect={() => onOpenDetails?.(result)}
                onInstall={() => requestInstall(result)}
              />
            ))}
          </Section>
        )}

        <Section title={`Installed (${installed.length})`} loading={extensions.loading}>
          {enabled.length === 0 && <Empty>Install an extension from Open VSX or use “Install from VSIX...” in the menu.</Empty>}
          {enabled.map((extension) => (
            <InstalledExtensionListItem
              key={extension.id}
              extension={extension}
              onSelect={() => onOpenDetails?.(extension)}
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
                onSelect={() => onOpenDetails?.(extension)}
                onEnable={() => void extensions.setEnabled(extension.id, true)}
                onDisable={() => void extensions.setEnabled(extension.id, false)}
                onUninstall={() => void extensions.uninstall(extension.id)}
              />
            ))}
          </Section>
        )}

        {!hasQuery && (
          <Section title={extensions.loadingRecommendations ? "Recommended (loading…)" : `Recommended (${extensions.recommended.length})`}>
            {extensions.recommended.length === 0 && !extensions.loadingRecommendations && <Empty>No recommendations available. Check your network connection or search Open VSX.</Empty>}
            {extensions.recommended.map((result) => (
              <SearchExtensionListItem
                key={result.id}
                result={result}
                installed={installedIds.has(result.id)}
                installing={extensions.installingId === result.id}
                onSelect={() => onOpenDetails?.(result)}
                onInstall={() => requestInstall(result)}
              />
            ))}
          </Section>
        )}

        <Section title={`Running Extensions (${extensions.running.length})`}>
          {extensions.running.length === 0 ? (
            <Empty>No extension commands have activated yet.</Empty>
          ) : (
            extensions.running.map((status) => (
              <div key={status.id} className="border-b border-[color:var(--ide-border)] px-3 py-2 text-[11px] text-[color:var(--ide-text)]">
                <div className="font-semibold text-[color:var(--ide-text-strong)]">{status.id}</div>
                <div color="var(--ide-muted)">
                  {status.activationReason ?? "activated"} · {status.activationTimeMs ?? 0}ms · crashes {status.crashCount}
                </div>
              </div>
            ))
          )}
        </Section>
      </div>
      {pendingInstall && (
        <TrustPublisherDialog
          extension={pendingInstall}
          onCancel={() => setPendingInstall(null)}
          onTrust={trustAndInstall}
        />
      )}
    </div>
  );
}

export function TrustPublisherDialog({ extension, onCancel, onTrust }: { extension: InstalledExtension | ExtensionSearchResult; onCancel: () => void; onTrust: () => void }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-sm rounded-lg border border-[color:var(--ide-border)] bg-[color:var(--ide-panel)] p-4 shadow-2xl">
        <div className="text-[14px] font-semibold text-[color:var(--ide-text-strong)]">Do you trust the publisher “{extension.publisher}”?</div>
        <p className="mt-3 text-[12px] leading-relaxed text-[color:var(--ide-text)]">
          The extension <span className="font-semibold text-[color:var(--ide-text-strong)]">{extension.displayName || extension.name}</span> is published by <span className="font-semibold text-[color:var(--ide-text-strong)]">{extension.publisher}</span>. Extensions can run code in your workspace. Proceed only if you trust this publisher.
        </p>
        {"verified" in extension && extension.verified && <p className="mt-2 text-[11px] text-sky-200">✓ Open VSX marks this publisher as verified.</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border border-[color:var(--ide-border)] px-3 py-1.5 text-[12px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]">Cancel</button>
          <button onClick={onTrust} className="rounded bg-[color:var(--ide-accent)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90">Trust Publisher & Install</button>
        </div>
      </div>
    </div>
  );
}

const TRUSTED_PUBLISHERS_KEY = "shogo.desktop.extensions.trustedPublishers";

export function isPublisherTrusted(publisher: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const trusted = JSON.parse(window.localStorage.getItem(TRUSTED_PUBLISHERS_KEY) ?? "[]") as unknown;
    return Array.isArray(trusted) && trusted.includes(publisher);
  } catch {
    return false;
  }
}

export function trustPublisher(publisher: string): void {
  if (typeof window === "undefined") return;
  try {
    const trusted = JSON.parse(window.localStorage.getItem(TRUSTED_PUBLISHERS_KEY) ?? "[]") as unknown;
    const next = new Set(Array.isArray(trusted) ? trusted.filter((item): item is string => typeof item === "string") : []);
    next.add(publisher);
    window.localStorage.setItem(TRUSTED_PUBLISHERS_KEY, JSON.stringify([...next].sort()));
  } catch {
    window.localStorage.setItem(TRUSTED_PUBLISHERS_KEY, JSON.stringify([publisher]));
  }
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
