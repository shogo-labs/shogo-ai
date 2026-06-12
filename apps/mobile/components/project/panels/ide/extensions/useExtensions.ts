import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopExtensionsBridge, ExtensionHostDiagnostic, ExtensionRuntimeStatusBarItem, ExtensionSearchResult, InstalledExtension, TrustedPublisherRecord, WorkspaceTrustState } from "./types";

export interface RunningExtensionStatus {
  id: string;
  active: boolean;
  activationTimeMs?: number;
  activationReason?: string;
  crashCount: number;
}

export function getDesktopExtensionsBridge(): DesktopExtensionsBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { shogoDesktop?: { extensions?: DesktopExtensionsBridge } }).shogoDesktop?.extensions;
  if (!bridge) return null;
  for (const method of [
    "listInstalled", "search", "listTrustedPublishers", "trustPublisher", "getWorkspaceTrust", "trustWorkspace", "installFromVsix", "installFromRegistry", "uninstall", "enable", "disable",
    "restartHost", "checkUpdates", "update", "getContributions", "runCommand", "activateEvent", "getView", "getStatusBarItems", "getWebviewPanels", "getOutputChannels", "respondUiRequest", "updateWorkspaceState", "onEvent", "showRunningExtensions", "startBisect",
  ] as const) {
    if (typeof bridge[method] !== "function") return null;
  }
  return bridge;
}

function installResultMessage(extension: InstalledExtension | undefined): string {
  if (!extension) return "Extension installed. Restart extensions to apply changes.";
  if (!extension.hasUsableEntryPoint) {
    return extension.unsupportedSurfaceMessage ?? "Extension installed, but no usable entry point is currently reachable.";
  }
  const first = extension.usableEntryPoints[0];
  return first
    ? `Extension installed. Restart extensions to use ${first.label}.`
    : "Extension installed. Restart extensions to apply changes.";
}

export function useExtensions({ workspaceRoot }: { workspaceRoot?: string | null } = {}) {
  const bridge = useMemo(() => getDesktopExtensionsBridge(), []);
  const [installed, setInstalled] = useState<InstalledExtension[]>([]);
  const [results, setResults] = useState<ExtensionSearchResult[]>([]);
  const [recommended, setRecommended] = useState<ExtensionSearchResult[]>([]);
  const [running, setRunning] = useState<RunningExtensionStatus[]>([]);
  const [diagnostics, setDiagnostics] = useState<ExtensionHostDiagnostic[]>([]);
  const [trustedPublishers, setTrustedPublishers] = useState<TrustedPublisherRecord[]>([]);
  const [workspaceTrust, setWorkspaceTrust] = useState<WorkspaceTrustState>({ trusted: !workspaceRoot, restrictedMode: !!workspaceRoot });
  const [statusBarItems, setStatusBarItems] = useState<ExtensionRuntimeStatusBarItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loadingRecommendations, setLoadingRecommendations] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError(null);
    try {
      const response = await bridge.listInstalled(workspaceRoot ?? undefined);
      if (!response.ok) throw new Error(response.error ?? "Failed to list extensions");
      setInstalled(response.extensions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [bridge, workspaceRoot]);

  const loadTrustedPublishers = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.listTrustedPublishers();
    if (response.ok) setTrustedPublishers(response.publishers ?? []);
  }, [bridge]);

  const loadWorkspaceTrust = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.getWorkspaceTrust(workspaceRoot ?? undefined);
    if (response.ok && response.trust) setWorkspaceTrust(response.trust);
  }, [bridge, workspaceRoot]);

  const loadStatusBarItems = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.getStatusBarItems(workspaceRoot ?? undefined);
    if (response.ok) setStatusBarItems(response.items ?? []);
  }, [bridge, workspaceRoot]);

  const loadRunningExtensions = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.showRunningExtensions();
    if (response.ok) {
      setRunning((response.running ?? []) as RunningExtensionStatus[]);
      setDiagnostics(response.diagnostics ?? []);
    }
    await loadStatusBarItems();
  }, [bridge, loadStatusBarItems]);

  const loadRecommendations = useCallback(async () => {
    if (!bridge) return;
    setLoadingRecommendations(true);
    try {
      const response = await bridge.search("@recommended", { size: 8 });
      if (!response.ok) throw new Error(response.error ?? "Failed to load recommendations");
      setRecommended(response.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingRecommendations(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
    void loadTrustedPublishers();
    void loadWorkspaceTrust();
    void loadRecommendations();
    void loadRunningExtensions();
    void loadStatusBarItems();
  }, [refresh, loadTrustedPublishers, loadWorkspaceTrust, loadRecommendations, loadRunningExtensions, loadStatusBarItems]);

  const runSearch = useCallback(async (value = query) => {
    if (!bridge) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setResults([]);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const response = await bridge.search(trimmed, { size: 20 });
      if (!response.ok) throw new Error(response.error ?? "Extension search failed");
      setResults(response.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [bridge, query]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setError(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void runSearch(trimmed);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  const trustedPublisherKeys = useMemo(() => new Set(trustedPublishers.map((publisher) => publisher.publisherKey)), [trustedPublishers]);

  const isPublisherTrusted = useCallback((publisher: string) => {
    return trustedPublisherKeys.has(publisher.trim().toLowerCase());
  }, [trustedPublisherKeys]);

  const trustPublisher = useCallback(async (publisher: string): Promise<boolean> => {
    if (!bridge) return false;
    setError(null);
    const response = await bridge.trustPublisher(publisher);
    if (!response.ok) {
      setError(response.error ?? `Failed to trust publisher: ${publisher}`);
      return false;
    }
    await loadTrustedPublishers();
    return true;
  }, [bridge, loadTrustedPublishers]);

  const trustWorkspace = useCallback(async (): Promise<boolean> => {
    if (!bridge || !workspaceRoot) return false;
    setError(null);
    const response = await bridge.trustWorkspace(workspaceRoot);
    if (!response.ok) {
      setError(response.error ?? "Failed to trust workspace");
      return false;
    }
    setMessage("Workspace trusted. Restricted Mode is off for this workspace.");
    await loadWorkspaceTrust();
    await refresh();
    await loadRunningExtensions();
    return true;
  }, [bridge, workspaceRoot, loadWorkspaceTrust, refresh, loadRunningExtensions]);

  const installFromVsix = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    const response = await bridge.installFromVsix(workspaceRoot ?? undefined);
    if (!response.ok) {
      if (!response.cancelled) setError(response.error ?? "VSIX install failed");
      return;
    }
    setMessage(installResultMessage(response.extension));
    await refresh();
    await loadTrustedPublishers();
    await loadRecommendations();
  }, [bridge, workspaceRoot, refresh, loadTrustedPublishers, loadRecommendations]);

  const installFromRegistry = useCallback(async (id: string, version?: string) => {
    if (!bridge) return;
    setError(null);
    setInstallingId(id);
    try {
      const response = await bridge.installFromRegistry(id, version, workspaceRoot ?? undefined);
      if (!response.ok) {
        if (!response.cancelled) setError(response.error ?? "Extension install failed");
        return;
      }
      setMessage(installResultMessage(response.extension));
      await refresh();
      await loadTrustedPublishers();
      await loadRecommendations();
    } finally {
      setInstallingId(null);
    }
  }, [bridge, workspaceRoot, refresh, loadTrustedPublishers, loadRecommendations]);

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    if (!bridge) return;
    setError(null);
    const response = enabled
      ? await bridge.enable(id, "global", workspaceRoot ?? undefined)
      : await bridge.disable(id, "global", workspaceRoot ?? undefined);
    if (!response.ok) {
      setError(response.error ?? `Failed to ${enabled ? "enable" : "disable"} extension`);
      return;
    }
    setMessage("Restart extensions to apply changes.");
    await refresh();
  }, [bridge, refresh, workspaceRoot]);

  const uninstall = useCallback(async (id: string) => {
    if (!bridge) return;
    setError(null);
    const response = await bridge.uninstall(id);
    if (!response.ok) {
      setError(response.error ?? "Failed to uninstall extension");
      return;
    }
    setMessage("Extension uninstalled. Restart extensions to apply changes.");
    await refresh();
    await loadRecommendations();
  }, [bridge, refresh, loadRecommendations]);

  const restartHost = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    const response = await bridge.restartHost(workspaceRoot ?? undefined);
    if (!response.ok) {
      setError(response.error ?? "Failed to restart extensions");
      return;
    }
    setMessage(response.message ?? "Extensions restarted.");
    await refresh();
    await loadRunningExtensions();
    await loadStatusBarItems();
  }, [bridge, refresh, workspaceRoot, loadRunningExtensions, loadStatusBarItems]);

  const showRunningExtensions = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.showRunningExtensions();
    if (!response.ok) setError(response.error ?? "Failed to inspect running extensions");
    else {
      setRunning((response.running ?? []) as RunningExtensionStatus[]);
      setDiagnostics(response.diagnostics ?? []);
      const errorCount = (response.diagnostics ?? []).filter((diagnostic) => diagnostic.level === "error").length;
      setMessage(response.message ?? `${response.running?.length ?? 0} extension(s) active${errorCount ? ` · ${errorCount} host issue(s)` : ""}.`);
      await loadStatusBarItems();
    }
  }, [bridge, loadStatusBarItems]);

  const startBisect = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.startBisect();
    if (!response.ok) setError(response.error ?? "Extension bisect is unavailable");
  }, [bridge]);

  const checkUpdates = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.checkUpdates();
    if (!response.ok) setError(response.error ?? "Failed to check for extension updates");
    else setMessage("No extension updates available yet.");
  }, [bridge]);

  const runCommand = useCallback(async (commandId: string) => {
    if (!bridge) return;
    setError(null);
    const response = await bridge.runCommand(commandId, [], workspaceRoot ?? undefined);
    if (!response.ok) {
      setError(response.error ?? `Extension command failed: ${commandId}`);
      return;
    }
    setMessage(`Ran ${commandId}`);
    await loadRunningExtensions();
    await loadStatusBarItems();
  }, [bridge, workspaceRoot, loadRunningExtensions, loadStatusBarItems]);

  const restartRequired = installed.some((extension) => extension.restartRequired);
  const disabledCount = installed.filter((extension) => !extension.enabled).length;

  return {
    available: !!bridge,
    installed,
    results,
    recommended,
    running,
    diagnostics,
    trustedPublishers,
    workspaceTrust,
    statusBarItems,
    query,
    loading,
    searching,
    loadingRecommendations,
    installingId,
    error,
    message,
    restartRequired,
    disabledCount,
    setQuery,
    refresh,
    runSearch,
    loadTrustedPublishers,
    loadWorkspaceTrust,
    isPublisherTrusted,
    trustPublisher,
    trustWorkspace,
    installFromVsix,
    installFromRegistry,
    setEnabled,
    uninstall,
    restartHost,
    showRunningExtensions,
    loadStatusBarItems,
    startBisect,
    checkUpdates,
    runCommand,
  };
}
