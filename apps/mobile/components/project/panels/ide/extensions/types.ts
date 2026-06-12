export type ExtensionInstallSource = "vsix" | "open-vsx" | "private";

export interface ExtensionManifestSummary {
  id: string;
  publisher: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  categories?: string[];
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string; title: string; category?: string }>;
    views?: Record<string, Array<{ id: string; name: string }>>;
    [key: string]: unknown;
  };
}

export interface InstalledExtension {
  id: string;
  publisher: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  source: ExtensionInstallSource;
  installedAt: number;
  updatedAt: number;
  compatible: boolean;
  compatibilityReason?: string;
  warnings: string[];
  autoUpdate: boolean;
  restartRequired?: boolean;
  enabled: boolean;
  disabledGlobally: boolean;
  disabledForWorkspace: boolean;
  manifest: ExtensionManifestSummary;
}

export interface ExtensionSearchResult {
  id: string;
  name: string;
  publisher: string;
  displayName: string;
  description: string;
  version: string;
  iconUrl?: string;
  downloads?: number;
  rating?: number;
  verified?: boolean;
  preRelease?: boolean;
  source: "open-vsx" | "private" | "local-vsix";
  categories: string[];
  tags: string[];
}

export interface DesktopExtensionsBridge {
  listInstalled(workspaceRoot?: string): Promise<{ ok: boolean; extensions?: InstalledExtension[]; error?: string }>;
  search(query: string, options?: { size?: number }): Promise<{ ok: boolean; results?: ExtensionSearchResult[]; error?: string }>;
  installFromVsix(): Promise<{ ok: boolean; extension?: InstalledExtension; restartRequired?: boolean; cancelled?: boolean; error?: string }>;
  installFromRegistry(id: string, version?: string): Promise<{ ok: boolean; extension?: InstalledExtension; restartRequired?: boolean; error?: string }>;
  uninstall(id: string): Promise<{ ok: boolean; restartRequired?: boolean; error?: string }>;
  enable(id: string, scope?: "global" | "workspace", workspaceRoot?: string): Promise<{ ok: boolean; restartRequired?: boolean; error?: string }>;
  disable(id: string, scope?: "global" | "workspace", workspaceRoot?: string): Promise<{ ok: boolean; restartRequired?: boolean; error?: string }>;
  restartHost(workspaceRoot?: string): Promise<{ ok: boolean; restarted?: boolean; message?: string; error?: string }>;
  checkUpdates(): Promise<{ ok: boolean; updates?: unknown[]; error?: string }>;
  update(id: string): Promise<{ ok: boolean; error?: string }>;
  getContributions(workspaceRoot?: string): Promise<{ ok: boolean; extensions?: InstalledExtension[]; contributions?: unknown[]; error?: string }>;
  runCommand(commandId: string, args?: unknown[], workspaceRoot?: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  showRunningExtensions(): Promise<{ ok: boolean; running?: unknown[]; message?: string; error?: string }>;
  startBisect(): Promise<{ ok: boolean; error?: string }>;
}
