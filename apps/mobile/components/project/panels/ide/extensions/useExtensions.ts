import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopExtensionsBridge, ExtensionSearchResult, InstalledExtension } from "./types";

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
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runSearch = useCallback(async (value = query) => {
    if (!bridge) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setResults([]);
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
  }, [bridge, refresh]);

  const installFromRegistry = useCallback(async (id: string, version?: string) => {
    if (!bridge) return;
    setError(null);
    const response = await bridge.installFromRegistry(id, version);
    if (!response.ok) {
      setError(response.error ?? "Extension install failed");
      return;
    }
    setMessage("Extension installed. Restart extensions to apply changes.");
    await refresh();
  }, [bridge, refresh]);

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
  }, [bridge, refresh]);

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
  }, [bridge, refresh]);

  const showRunningExtensions = useCallback(async () => {
    if (!bridge) return;
    const response = await bridge.showRunningExtensions();
    if (!response.ok) setError(response.error ?? "Failed to inspect running extensions");
    else setMessage(response.message ?? "No extension host is running yet.");
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

  const restartRequired = installed.some((extension) => extension.restartRequired);
  const disabledCount = installed.filter((extension) => !extension.enabled).length;

  return {
    available: !!bridge,
    installed,
    results,
    query,
    loading,
    searching,
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
  };
}
