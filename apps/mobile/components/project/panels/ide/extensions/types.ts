export type ExtensionInstallSource = "vsix" | "open-vsx" | "private";

export interface ExtensionCommandContribution {
  command: string;
  title: string;
  category?: string;
  icon?: string | { light?: string; dark?: string };
}

export interface ExtensionViewContribution {
  id: string;
  name: string;
  when?: string;
  icon?: string;
  contextualTitle?: string;
  visibility?: "visible" | "collapsed" | "hidden";
}

export interface ExtensionViewContainerContribution {
  id: string;
  title: string;
  icon?: string;
}

export interface ExtensionMenuContribution {
  command: string;
  when?: string;
  group?: string;
  alt?: string;
}

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
    commands?: ExtensionCommandContribution[];
    menus?: Record<string, ExtensionMenuContribution[]>;
    views?: Record<string, ExtensionViewContribution[]>;
    viewsContainers?: {
      activitybar?: ExtensionViewContainerContribution[];
      panel?: ExtensionViewContainerContribution[];
    };
    viewsWelcome?: Array<Record<string, unknown>>;
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
  iconUrl?: string;
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

export interface ExtensionRuntimeCommand {
  command: string;
  title?: string;
  arguments?: unknown[];
}

export interface ExtensionRuntimeTreeItem {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  collapsibleState?: number;
  command?: ExtensionRuntimeCommand;
}

export interface ExtensionRuntimeViewResult {
  viewId: string;
  extensionId: string;
  items: ExtensionRuntimeTreeItem[];
  message?: string;
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
  activateEvent(event: string, workspaceRoot?: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  getView(viewId: string, workspaceRoot?: string): Promise<{ ok: boolean; view?: ExtensionRuntimeViewResult; error?: string }>;
  showRunningExtensions(): Promise<{ ok: boolean; running?: unknown[]; message?: string; error?: string }>;
  startBisect(): Promise<{ ok: boolean; error?: string }>;
}
