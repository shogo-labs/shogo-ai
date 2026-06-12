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

export interface TrustedPublisherRecord {
  publisher: string;
  publisherKey: string;
  trustedAt: number;
  source: "user" | "policy";
}

export interface WorkspaceTrustState {
  workspaceRoot?: string;
  workspaceKey?: string;
  trusted: boolean;
  restrictedMode: boolean;
  source?: "user" | "policy";
  trustedAt?: number;
}

export interface WorkspaceTrustRecord {
  workspaceRoot: string;
  workspaceKey: string;
  trusted: boolean;
  trustedAt?: number;
  source: "user" | "policy";
}

export type RestrictedModeSupport = "full" | "limited" | "unsupported";
export type ExtensionUsableEntryPointKind = "command" | "view" | "viewContainer" | "startupActivation";

export interface ExtensionUsableEntryPoint {
  kind: ExtensionUsableEntryPointKind;
  id: string;
  label: string;
  detail?: string;
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
  trustedPublisher: boolean;
  trustedPublisherAt?: number;
  workspaceTrusted: boolean;
  restrictedMode: boolean;
  restrictedModeSupport: RestrictedModeSupport;
  disabledByRestrictedMode: boolean;
  restrictedModeReason?: string;
  usableEntryPoints: ExtensionUsableEntryPoint[];
  hasUsableEntryPoint: boolean;
  unsupportedSurfaceMessage?: string;
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
  handle?: string;
  parentHandle?: string;
  label: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  collapsibleState?: number;
  command?: ExtensionRuntimeCommand;
}

export interface ExtensionRuntimeViewResult {
  kind?: "tree" | "webview" | "empty";
  viewId: string;
  extensionId: string;
  itemHandle?: string;
  items?: ExtensionRuntimeTreeItem[];
  html?: string;
  title?: string;
  message?: string;
}

export interface ExtensionRuntimeStatusBarItem {
  id: string;
  extensionId: string;
  text: string;
  tooltip?: string;
  command?: string | ExtensionRuntimeCommand;
  alignment: "left" | "right";
  priority?: number;
  visible: boolean;
}

export interface ExtensionRuntimeWebviewPanel {
  id: string;
  extensionId: string;
  viewType: string;
  title: string;
  html: string;
  active: boolean;
}

export interface ExtensionOutputChannel {
  id: string;
  extensionId: string;
  name: string;
  visible: boolean;
  disposed: boolean;
  lines: string;
  updatedAt: number;
}

export interface ExtensionUiRequest {
  requestId: string;
  extensionId: string;
  kind: "notification" | "quickPick" | "inputBox";
  payload: Record<string, unknown>;
}

export type ExtensionHostEvent =
  | { type: "outputChanged"; channels: ExtensionOutputChannel[]; changed?: ExtensionOutputChannel }
  | { type: "uiRequest"; request: ExtensionUiRequest };

export interface ExtensionWorkspaceDocument {
  path: string;
  fsPath?: string;
  languageId: string;
  version: number;
  text: string;
  isDirty?: boolean;
}

export interface ExtensionWorkspaceState {
  workspaceRoot?: string;
  workspaceName?: string;
  activeDocumentPath?: string | null;
  visibleDocumentPaths?: string[];
  documents?: ExtensionWorkspaceDocument[];
  configuration?: Record<string, unknown>;
}

export interface DesktopExtensionsBridge {
  listInstalled(workspaceRoot?: string): Promise<{ ok: boolean; extensions?: InstalledExtension[]; error?: string }>;
  search(query: string, options?: { size?: number }): Promise<{ ok: boolean; results?: ExtensionSearchResult[]; error?: string }>;
  listTrustedPublishers(): Promise<{ ok: boolean; publishers?: TrustedPublisherRecord[]; error?: string }>;
  trustPublisher(publisher: string): Promise<{ ok: boolean; publisher?: TrustedPublisherRecord; error?: string }>;
  getWorkspaceTrust(workspaceRoot?: string): Promise<{ ok: boolean; trust?: WorkspaceTrustState; error?: string }>;
  trustWorkspace(workspaceRoot: string): Promise<{ ok: boolean; workspace?: WorkspaceTrustRecord; restartRequired?: boolean; error?: string }>;
  installFromVsix(workspaceRoot?: string): Promise<{ ok: boolean; extension?: InstalledExtension; restartRequired?: boolean; cancelled?: boolean; error?: string }>;
  installFromRegistry(id: string, version?: string, workspaceRoot?: string): Promise<{ ok: boolean; extension?: InstalledExtension; restartRequired?: boolean; cancelled?: boolean; error?: string }>;
  uninstall(id: string): Promise<{ ok: boolean; restartRequired?: boolean; error?: string }>;
  enable(id: string, scope?: "global" | "workspace", workspaceRoot?: string): Promise<{ ok: boolean; restartRequired?: boolean; error?: string }>;
  disable(id: string, scope?: "global" | "workspace", workspaceRoot?: string): Promise<{ ok: boolean; restartRequired?: boolean; error?: string }>;
  restartHost(workspaceRoot?: string): Promise<{ ok: boolean; restarted?: boolean; message?: string; error?: string }>;
  checkUpdates(): Promise<{ ok: boolean; updates?: unknown[]; error?: string }>;
  update(id: string): Promise<{ ok: boolean; error?: string }>;
  getContributions(workspaceRoot?: string): Promise<{ ok: boolean; extensions?: InstalledExtension[]; contributions?: unknown[]; error?: string }>;
  runCommand(commandId: string, args?: unknown[], workspaceRoot?: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  activateEvent(event: string, workspaceRoot?: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  getView(viewId: string, workspaceRoot?: string, itemHandle?: string): Promise<{ ok: boolean; view?: ExtensionRuntimeViewResult; error?: string }>;
  getStatusBarItems(workspaceRoot?: string): Promise<{ ok: boolean; items?: ExtensionRuntimeStatusBarItem[]; error?: string }>;
  getWebviewPanels(workspaceRoot?: string): Promise<{ ok: boolean; panels?: ExtensionRuntimeWebviewPanel[]; error?: string }>;
  getOutputChannels(workspaceRoot?: string): Promise<{ ok: boolean; channels?: ExtensionOutputChannel[]; error?: string }>;
  respondUiRequest(requestId: string, response: { ok: boolean; result?: unknown; error?: string }): Promise<{ ok: boolean; error?: string }>;
  updateWorkspaceState(state: ExtensionWorkspaceState): Promise<{ ok: boolean; error?: string }>;
  onEvent(callback: (event: ExtensionHostEvent) => void): () => void;
  showRunningExtensions(): Promise<{ ok: boolean; running?: unknown[]; message?: string; error?: string }>;
  startBisect(): Promise<{ ok: boolean; error?: string }>;
}
