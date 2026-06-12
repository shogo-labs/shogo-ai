import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopExtensionsBridge, ExtensionSearchResult, InstalledExtension } from "./types";

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
    "listInstalled", "search", "installFromVsix", "installFromRegistry", "uninstall", "enable", "disable",
    "restartHost", "checkUpdates", "update", "getContributions", "runCommand", "showRunningExtensions", "startBisect",
  ] as const) {
    if (typeof bridge[method] !== "function") return null;
  }
  return bridge;
}

export function useExtensions({ workspaceRoot }: { workspaceRoot?: string | null } = {}) {
  const bridge = useMemo(() => getDesktopExtensionsBridge(), []);
  const [installed, setInstalled] = useState<InstalledExtension[]>([]);
  const [results, setResults] = useState<ExtensionSearchResult[]>([]);
  const [recommended, setRecommended] = useState<ExtensionSearchResult[]>([]);
  const [running, setRunning] = useState<RunningExtensionStatus[]>([]);
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

  const loadRunningExtensions = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.showRunningExtensions();
    if (response.ok) setRunning((response.running ?? []) as RunningExtensionStatus[]);
  }, [bridge]);

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
    void loadRecommendations();
    void loadRunningExtensions();
  }, [refresh, loadRecommendations, loadRunningExtensions]);

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

  const installFromVsix = useCallback(async () => {
    if (!bridge) return;
    setError(null);
    const response = await bridge.installFromVsix();
    if (!response.ok) {
      if (!response.cancelled) setError(response.error ?? "VSIX install failed");
      return;
    }
    setMessage("Extension installed. Restart extensions to apply changes.");
    await refresh();
    await loadRecommendations();
  }, [bridge, refresh, loadRecommendations]);

  const installFromRegistry = useCallback(async (id: string, version?: string) => {
    if (!bridge) return;
    setError(null);
    setInstallingId(id);
    try {
      const response = await bridge.installFromRegistry(id, version);
      if (!response.ok) {
        setError(response.error ?? "Extension install failed");
        return;
      }
      setMessage("Extension installed. Restart extensions to apply changes.");
      await refresh();
      await loadRecommendations();
    } finally {
      setInstallingId(null);
    }
  }, [bridge, refresh, loadRecommendations]);

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
  }, [bridge, refresh, workspaceRoot, loadRunningExtensions]);

  const showRunningExtensions = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.showRunningExtensions();
    if (!response.ok) setError(response.error ?? "Failed to inspect running extensions");
    else {
      setRunning((response.running ?? []) as RunningExtensionStatus[]);
      setMessage(response.message ?? `${response.running?.length ?? 0} extension(s) active.`);
    }
  }, [bridge]);

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
  }, [bridge, workspaceRoot, loadRunningExtensions]);

  const restartRequired = installed.some((extension) => extension.restartRequired);
  const disabledCount = installed.filter((extension) => !extension.enabled).length;

  return {
    available: !!bridge,
    installed,
    results,
    recommended,
    running,
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
    installFromVsix,
    installFromRegistry,
    setEnabled,
    uninstall,
    restartHost,
    showRunningExtensions,
    startBisect,
    checkUpdates,
    runCommand,
  };
}
