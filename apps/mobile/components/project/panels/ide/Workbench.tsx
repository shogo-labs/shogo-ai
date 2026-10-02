import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { useResizable, VerticalSplit } from "./Splitter";
import { ActivityBar } from "./ActivityBar";
import { FileTree, type FileTreeHandlers } from "./FileTree";
import { StatusBar } from "./StatusBar";
import { useGitStatus } from "./git/useGitStatus";
import { isDesktopRuntime } from "./terminal/pty-factory";
import { gitChangeCount, type BadgeData } from "./badges/formatBadge";
import { useProblemsBadgeCount } from "./badges/useProblemsBadgeCount";
import { GitStatusProvider } from "./git/GitStatusContext";
import { SourceControlViewlet } from "./scm/SourceControlViewlet";
import { RunDebugPanel } from "./run/RunDebugPanel";
import { GraphView } from "./graph/GraphView";
import { CheckpointListView } from "./CheckpointListView";
import { attachGitDecorations, maybeAutoStageIfConflictResolved } from "./git/editorIntegration";
import { MergeEditorModal } from "./git/MergeEditorModal";
import { getDesktopGitBridge } from "./git/bridge";
import { getDesktopFsBridge } from "./workspace/desktopFs";
import { languageFor } from "./workspace/language";
import { EditorGroupView } from "./EditorGroup";
import { applyEditorChange } from "./editor-change-apply";
import { collectDirtyFiles, resolveSaveTarget } from "./save-target";
import { findEditorForFileId } from "./model-by-uri";
import { isImagePath } from "./ImagePreview";
import {
  isAudioPath,
  isFontPath,
  isPdfPath,
  isVideoPath,
} from "./MediaPreview";
import { Palette, type PaletteItem } from "./Palette";
import { buildDisambiguation, type QuickOpenFile } from "./quick-open-disambiguate";
import {
  ideBottomPanelStore,
  useBottomPanelState,
} from "../../../../lib/ide-bottom-panel-store";
import {
  consumePendingIdeActivity,
  subscribeIdeActivity,
} from "../../../../lib/ide-activity-bus";
import {
  DEFAULT_SETTINGS,
  type ActivityId,
  type EditorGroup,
  type EditorSettings,
  type OpenFile,
  type RawNode,
  type Root,
  type TreeNode,
} from "./types";
import { broadcastEditorFontChange } from "./useEditorFont";
import { SearchPane, type SearchPersist, type SearchSeed } from "./SearchPane";
import { preloadMonaco } from "./CodeEditor";
import { loadSession, saveSession, sessionHasTabs, snapshotSession } from "./session";
import { SettingsPane } from "./SettingsPane";
import { ExtensionsViewlet, TrustPublisherDialog } from "./extensions/ExtensionsViewlet";
import { collectRuntimeContainers, ExtensionRuntimeViewlet } from "./extensions/ExtensionRuntimeViewlet";
import { getDesktopExtensionsBridge, useExtensions } from "./extensions/useExtensions";
import type { ExtensionHostEvent, ExtensionRuntimeViewResult, ExtensionRuntimeWebviewPanel, ExtensionSearchResult, ExtensionUiRequest, ExtensionUsableEntryPoint, ExtensionWorkspaceState, InstalledExtension } from "./extensions/types";
import { useLiveAgentEdits, type LiveConflict } from "./useLiveAgentEdits";
import { AgentEditBanner } from "./AgentEditBanner";
import { ConfirmDialog, describeFileNames, type ConfirmButton } from "./ConfirmDialog";
import { applyAgentEdit, type MonacoNs } from "./agentEditAnimation";
import { FIX_IN_AGENT_EVENT, type FixInAgentPayload } from "./agentFixProvider";
import type { WorkspaceService } from "./workspace/types";
// Workspace services are injected by the parent (WorkspaceService impls per root).
import { isFsaSupported, pickDirectory, ensurePermission, LocalFs } from "./workspace/localFs";
import { saveRoot, listRoots, deleteRoot, touchRoot } from "./workspace/handleStore";
import { disposeWorkspaceModels, removeModel, removeModelsUnderPath } from "./monaco/workspaceModels";
import { setupLspProviders } from "./monaco/lspProviders";
import { setupLspDocumentSync } from "./monaco/lspDocumentSync";
import { matchesShortcut, type Command } from "./commands";
import { resolvePaletteIntent } from "./keybindings";
import {
  INITIAL_ZEN_STATE,
  advanceZenChord,
  computeChromeVisibility,
  shouldExitOnEscape,
  toggleZen,
  type ZenState,
} from "./zen-mode";
import { useTheme } from "../../../../contexts/theme";
import { isBinaryFilePath } from "@shogo-ai/sdk/file-types";
import {
  RefreshCw,
  History,
  AlertTriangle,
  FilePlus,
  FolderPlus,
  FolderOpen,
  Folder,
  PanelLeftClose,
  ChevronsDownUp,
  GitBranch,
  X,
} from "lucide-react-native";

let groupSeq = 1;
const newGroupId = () => `g${groupSeq++}`;

/** SQLite database files are binary, but we render them in a read-only
 *  SQLite preview (tables + sample rows) instead of refusing to open. */
const SQLITE_EXTENSIONS = new Set(["db", "sqlite", "sqlite3"]);
function isSqlitePath(path: string): boolean {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return SQLITE_EXTENSIONS.has(ext);
}

/** Preview "languages" — pseudo-Monaco-language tags we stash on an OpenFile
 *  to tell EditorGroupView which preview component to mount. Any file whose
 *  language matches one of these is opened via svc.readFileUrl() (not
 *  readFile()) and its OpenFile.content holds a URL rather than text. */
type PreviewLanguage = "image" | "sqlite" | "pdf" | "audio" | "video" | "font";
type PrimarySideBarPosition = "left" | "right";
const PREVIEW_LANGUAGES: ReadonlySet<string> = new Set<PreviewLanguage>([
  "image", "sqlite", "pdf", "audio", "video", "font",
]);
function previewLanguageFor(path: string): PreviewLanguage | null {
  if (isImagePath(path)) return "image";
  if (isSqlitePath(path)) return "sqlite";
  if (isPdfPath(path)) return "pdf";
  if (isAudioPath(path)) return "audio";
  if (isVideoPath(path)) return "video";
  if (isFontPath(path)) return "font";
  return null;
}
/** Human-friendly viewer name for error toasts when readFileUrl is missing. */
const PREVIEW_LABEL: Record<PreviewLanguage, string> = {
  image: "Image",
  sqlite: "SQLite",
  pdf: "PDF",
  audio: "Audio",
  video: "Video",
  font: "Font",
};

/** Resolve the theme preference to a concrete "light" | "dark" — mirrors the
 *  logic in ThemeProvider so the IDE's Monaco and chrome colours stay in sync
 *  with the rest of the app, including when the user picks "system" and the
 *  OS-level scheme flips underfoot. */
function useResolvedTheme(): "light" | "dark" {
  const { theme } = useTheme();
  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [theme]);
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return systemDark ? "dark" : "light";
}

const fileId = (rootId: string, path: string) => `${rootId}::${path}`;

function workspaceFsPath(root: string, relPath: string): string {
  const trimmedRoot = root.replace(/[\\/]+$/, "");
  const trimmedPath = relPath.replace(/^[\\/]+/, "");
  return `${trimmedRoot}/${trimmedPath}`;
}

function documentVersion(content: string, dirty: boolean): number {
  let hash = dirty ? 17 : 0;
  for (let i = 0; i < content.length; i++) hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** Debounce for auto save while typing (ms). */
const AUTO_SAVE_DELAY_MS = 1000;

function annotateRoot(nodes: RawNode[], rootId: string): TreeNode[] {
  return nodes.map((n) => ({
    ...n,
    rootId,
    children: n.children ? annotateRoot(n.children, rootId) : undefined,
  }));
}

/**
 * Walk `tree`, find the directory at `path`, and replace its children with
 * `children` (clearing the `lazy` flag). Used by `loadSubtree` to splice a
 * just-fetched subtree into the root in a structurally-shared, immutable
 * fashion so React only re-renders the affected branch.
 */
function spliceSubtree(
  tree: TreeNode[],
  path: string,
  children: TreeNode[],
): TreeNode[] {
  return tree.map((n) => {
    if (n.path === path && n.kind === "dir") {
      return { ...n, children, lazy: undefined };
    }
    if (
      n.kind === "dir" &&
      n.children &&
      (n.path === "" || path.startsWith(n.path + "/"))
    ) {
      return { ...n, children: spliceSubtree(n.children, path, children) };
    }
    return n;
  });
}

function flattenFiles(tree: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of tree) {
    if (n.kind === "file") out.push(n);
    else if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

export function Workbench({
  agentService,
  agentLabel = "agent-workspace",
  projectId,
  paneVisible = true,
  agentUrl,
  fetchImpl,
  isExternalProject = true,
  folderPath,
  remoteHostId,
  primarySideBarPosition = "left",
  requestedFile = null,
}: {
  agentService: WorkspaceService;
  agentLabel?: string;
  projectId?: string | null;
  /**
   * Whether the IDE pane is currently visible to the user. The Workbench
   * stays mounted under `display: none` when the user is on another tab so
   * the SSE subscription survives, but we use this to gate the polling
   * fallback in `useLiveAgentEdits` — running a 2s `readFile` loop against
   * a hidden panel just floods the network tab whenever the chat agent
   * edits a file.
   */
  paneVisible?: boolean;
  /**
   * Base URL of the agent runtime (e.g. http://localhost:38587). When set,
   * Monaco's hover / completion / definition / references / document-symbol
   * / signature-help / rename providers are routed to the backend
   * typescript-language-server via `/agent/lsp/*` instead of the in-browser
   * TS Web Worker. Lets us delete the 1000-file bulk preload entirely.
   */
  agentUrl?: string;
  /**
   * Authenticated fetch implementation (`agentFetch` from the mobile app)
   * used by the LSP providers and document-sync. Defaults to global `fetch`
   * for tests.
   */
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** True when the project was opened via "Open folder…" (external/IDE-style). */
  isExternalProject?: boolean;
  /** Absolute path to the project's primary folder (for external/open-folder projects). */
  folderPath?: string | null;
  /** Remote-SSH projects have no local git/IPC workspace root. */
  remoteHostId?: string | null;
  primarySideBarPosition?: PrimarySideBarPosition;
  /** Open this workspace-relative file once the agent root is loaded. */
  requestedFile?: { path: string; nonce: number; line?: number; column?: number } | null;
}) {
  const themeMode = useResolvedTheme();
  const [activity, setActivity] = useState<ActivityId>("files");
  const [graphOpen, setGraphOpen] = useState<boolean>(false);
  const [pendingExtensionInstall, setPendingExtensionInstall] = useState<InstalledExtension | ExtensionSearchResult | null>(null);

  // Deep-link: let surfaces outside the Workbench (e.g. the top-bar Publish
  // popover's "View history" link) switch the active activity — notably
  // "checkpoint" to reveal the commit graph. Consume any pending request on
  // mount (covers the case where the request fired before we mounted), then
  // subscribe for subsequent live requests.
  useEffect(() => {
    const KNOWN: ReadonlySet<string> = new Set([
      "files",
      "search",
      "git",
      "checkpoint",
      "debug",
      "extensions",
      "settings",
    ]);
    const apply = (id: string) => {
      if (KNOWN.has(id)) setActivity(id as ActivityId);
    };
    const pendingActivity = consumePendingIdeActivity();
    if (pendingActivity) apply(pendingActivity);
    return subscribeIdeActivity(apply);
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem("shogo.ide.sidebarOpen");
      if (raw === "false") return false;
    } catch { /* ignore */ }
    return true;
  });
  useEffect(() => {
    try { localStorage.setItem("shogo.ide.sidebarOpen", String(sidebarOpen)); } catch { /* ignore */ }
  }, [sidebarOpen]);

  useEffect(() => {
    const bridge = getDesktopExtensionsBridge();
    if (!bridge) return;
    return bridge.onEvent((event: ExtensionHostEvent) => {
      if (event.type === "uiRequest") setExtensionUiRequest(event.request);
    });
  }, []);

  const respondToExtensionUiRequest = useCallback((requestId: string, result?: unknown, ok = true) => {
    const bridge = getDesktopExtensionsBridge();
    if (!bridge) return;
    void bridge.respondUiRequest(requestId, ok ? { ok: true, result } : { ok: false, error: String(result ?? "Extension UI request cancelled") });
    setExtensionUiRequest((current) => current?.requestId === requestId ? null : current);
  }, []);

  // Bottom-panel state lives in the lifted store so the same drawer is
  // visible from anywhere in the project view (via DrawerHost mounted at
  // ProjectLayout). ⌘J / ⌘⇧` keybinds and the command palette here all
  // delegate to the store.
  const bottomPanelOpen = useBottomPanelState((s) => s.open);
  const setBottomPanelOpen = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    if (typeof next === "function") {
      ideBottomPanelStore.setOpen(next(ideBottomPanelStore.getState().open));
    } else {
      ideBottomPanelStore.setOpen(next);
    }
  }, []);
  const requestNewTerminal = useCallback(() => {
    ideBottomPanelStore.requestNewTerminal();
  }, []);
  const [services, setServices] = useState<Record<string, WorkspaceService>>({ agent: agentService });
  const [roots, setRoots] = useState<Root[]>([
    { id: "agent", label: agentLabel, kind: "agent", tree: [], loading: true, error: null },
  ]);

  const [groups, setGroups] = useState<EditorGroup[]>([
    { id: newGroupId(), files: [], activeId: null },
  ]);
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);
  const [conflicts, setConflicts] = useState<LiveConflict[]>([]);

  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [toast, setToast] = useState<string | null>(null);
  const [extensionUiRequest, setExtensionUiRequest] = useState<ExtensionUiRequest | null>(null);
  const [newRequest, setNewRequest] = useState<
    { kind: "file" | "dir"; nonce: number; rootId?: string } | null
  >(null);
  const [palette, setPalette] = useState<"command" | "file" | "line" | "language" | null>(null);

  // Zen mode (⌘K Z, double-Esc to leave). Chrome is *derived* from this state,
  // so leaving zen restores the exact previous layout with nothing to undo
  // except the bottom drawer (lives outside Workbench) and browser fullscreen.
  const [zen, setZen] = useState<ZenState>(INITIAL_ZEN_STATE);
  const chrome = useMemo(() => computeChromeVisibility(zen), [zen]);
  const zenPanelRestoreRef = useRef<boolean | null>(null);
  const zenChordPendingRef = useRef(false);
  const zenChordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEscapeAtRef = useRef<number | null>(null);
  const [markerCounts, setMarkerCounts] = useState({ errors: 0, warnings: 0 });
  const [editorInfo, setEditorInfo] = useState<{ selection: string | null; indent: string; eol: "LF" | "CRLF" }>({
    selection: null,
    indent: "Spaces: 2",
    eol: "LF",
  });

  // Editor settings — persisted to localStorage
  const [settings, setSettings] = useState<EditorSettings>(() => {
    try {
      const raw = localStorage.getItem("shogo.ide.settings");
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return DEFAULT_SETTINGS;
  });
  useEffect(() => {
    try {
      localStorage.setItem("shogo.ide.settings", JSON.stringify(settings));
    } catch { /* ignore */ }
  }, [settings]);

  // BUG-012 — propagate the font-family setting EVERYWHERE in one shot.
  //   1. Write `--ide-mono-font` inline on the .shogo-ide element. Every
  //      HTML panel that uses `font-mono` / `.ide-mono` (Output, Problems,
  //      Debug Console, Run & Debug Output, Debug View) inherits the new
  //      value via the cascade — no per-panel edits needed.
  //   2. Broadcast the same-tab change event so `useEditorFont()` consumers
  //      (Monaco canvas, xterm.js canvas) re-read and re-apply. `storage`
  //      doesn't fire in the writing tab so this is the ONLY signal that
  //      reaches same-tab listeners.
  // We use a ref to the .shogo-ide div instead of document.documentElement
  // so multiple Workbench instances (multi-workspace future) each own
  // their own font without bleeding into each other.
  const ideRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = ideRootRef.current;
    if (root) {
      // Inline style wins over the static `.shogo-ide { --ide-mono-font: … }`
      // rule in global.css — that's intentional, the static rule is just a
      // pre-React fallback for the initial paint.
      root.style.setProperty("--ide-mono-font", settings.fontFamily);
    }
    broadcastEditorFontChange(settings.fontFamily);
  }, [settings.fontFamily]);

  const sidebarSplit = useResizable({
    initial: 280,
    min: 200,
    max: 540,
    direction: "horizontal",
    invert: primarySideBarPosition === "right",
  });
  const groupSplit = useResizable({ initial: 0.5, min: 0.2, max: 0.8, direction: "horizontal" });

  const editorRefs = useRef<Record<string, editor.IStandaloneCodeEditor>>({});
  const [searchSeed, setSearchSeed] = useState<SearchSeed | undefined>(undefined);
  const searchPersistRef = useRef<SearchPersist | undefined>(undefined);
  const persistSearch = useCallback((s: SearchPersist) => {
    searchPersistRef.current = s;
  }, []);
  const monacoNsRef = useRef<MonacoNs | null>(null);
  // Bumped each time a Monaco editor mounts so the backend-LSP wiring effect
  // below can run as soon as `monaco` is first available (effects can't read
  // refs reactively).
  const [monacoReadyTick, setMonacoReadyTick] = useState(0);

  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  // In-IDE confirm dialog (Save / Don't Save / Cancel etc.). A promise API
  // keeps call sites linear; never call this from inside a state updater.
  const [confirmReq, setConfirmReq] = useState<{
    title: string;
    message: React.ReactNode;
    buttons: ConfirmButton<string>[];
    cancelValue: string;
  } | null>(null);
  const confirmResolveRef = useRef<((v: string) => void) | null>(null);
  const confirmReqCancelRef = useRef<string>("cancel");
  const resolveConfirm = useCallback((value: string) => {
    const r = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setConfirmReq(null);
    r?.(value);
  }, []);
  const askConfirm = useCallback(
    <T extends string>(req: {
      title: string;
      message: React.ReactNode;
      buttons: ConfirmButton<T>[];
      cancelValue: T;
    }): Promise<T> =>
      new Promise<T>((resolve) => {
        // A newer prompt supersedes an unanswered one (treated as cancel).
        confirmResolveRef.current?.(confirmReqCancelRef.current);
        confirmReqCancelRef.current = req.cancelValue;
        confirmResolveRef.current = resolve as (v: string) => void;
        setConfirmReq(req as unknown as NonNullable<typeof confirmReq>);
      }),
    [],
  );

  // Warn before the page unloads while any buffer has unsaved edits.
  const hasDirtyFiles = useMemo(
    () => groups.some((g) => g.files.some((f) => f.dirty)),
    [groups],
  );
  useEffect(() => {
    if (!hasDirtyFiles || typeof window === "undefined") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasDirtyFiles]);

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveIdForAutosaveRef = useRef<string | null>(null);
  // Ref so `persistOpenFile` can reach the latest git root without
  // re-creating itself every time the root changes.
  const gitWorkspaceRootRef = useRef<string | null>(null);
  // G4.5 — open relPath in the 3-way merge editor when non-null.
  const [mergePath, setMergePath] = useState<string | null>(null);
  const fsaSupported = useMemo(() => isFsaSupported(), []);

  const activeGroup = groups[activeGroupIdx] ?? groups[0];
  const active = activeGroup?.files.find((f) => f.id === activeGroup.activeId) ?? null;

  const showToast = useCallback((msg: string, ms = 1400) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), ms);
  }, []);

  // Keep the terminal panel informed of the active editor file and selection
  // so "Run Active File" and "Run Selected Text" work without prop-drilling.
  useEffect(() => {
    ideBottomPanelStore.setActiveEditorPath(active?.path ?? null);
  }, [active?.path]);

  useEffect(() => {
    ideBottomPanelStore.setGetEditorSelection(() => {
      const ed = editorRefs.current[activeGroup?.id ?? ""];
      if (!ed) return null;
      const selection = ed.getSelection();
      if (!selection || selection.isEmpty()) return null;
      return ed.getModel()?.getValueInRange(selection) ?? null;
    });
    return () => { ideBottomPanelStore.setGetEditorSelection(null); };
  });

  // ─── Virtual tree (wraps each root as an expandable "workspace" entry) ──
  const virtualTree = useMemo<TreeNode[]>(
    () =>
      roots.map((r) => ({
        name: r.label,
        path: "",
        kind: "dir",
        rootId: r.id,
        isRoot: true,
        children: r.tree,
      })),
    [roots],
  );

  // ─── Root loading ───────────────────────────────────────────────────
  const setRoot = useCallback((id: string, patch: Partial<Root>) => {
    setRoots((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  /** Lazy dirs (node_modules, dist…) the user has expanded, per root. */
  const loadedLazyRef = useRef<Record<string, Set<string>>>({});

  const loadRoot = useCallback(
    async (id: string) => {
      const svc = services[id];
      if (!svc) return;
      setRoot(id, { loading: true, error: null });
      try {
        const raw = await svc.listTree("", 4);
        setRoot(id, { tree: annotateRoot(raw, id), loading: false });
        // A refresh replaces every lazy dir with an unloaded stub, which
        // would collapse `node_modules`/`dist` the user already expanded
        // (their rows would turn into "empty"). Re-fetch them, parents first
        // so nested splices land on already-loaded parents.
        const loaded = loadedLazyRef.current[id];
        if (loaded && loaded.size > 0) {
          const paths = [...loaded].sort((a, b) => a.length - b.length);
          for (const p of paths) {
            try {
              const kids = annotateRoot(await svc.listTree(p), id);
              setRoots((prev) =>
                prev.map((r) => (r.id === id ? { ...r, tree: spliceSubtree(r.tree, p, kids) } : r)),
              );
            } catch {
              loaded.delete(p); // gone or unreadable — let the user re-expand
            }
          }
        }
        // Cross-file IntelliSense is served by the backend
        // typescript-language-server (see `setupLspProviders` below); we used
        // to preload up to 1000 TS/JS files into Monaco here to feed the
        // in-browser TS Web Worker, but that bulk read is no longer needed —
        // tsserver reads files off disk natively.
      } catch (err) {
        setRoot(id, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [services, setRoot],
  );

  const refreshAllRoots = useCallback(async () => {
    await Promise.all(Object.keys(services).map((id) => loadRoot(id)));
  }, [services, loadRoot]);

  /**
   * Fetch the children of a lazy directory on demand and splice them into the
   * root's tree. Used when the user expands `node_modules`, `dist`, etc. —
   * the server returns those as `{ lazy: true, children: undefined }` to keep
   * the initial tree payload small. Throws on failure so the FileTree can
   * surface a per-row error + retry affordance.
   */
  const loadSubtree = useCallback(
    async (rootId: string, path: string) => {
      const svc = services[rootId];
      if (!svc) throw new Error(`Unknown workspace: ${rootId}`);
      const raw = await svc.listTree(path);
      const children = annotateRoot(raw, rootId);
      (loadedLazyRef.current[rootId] ??= new Set()).add(path);
      setRoots((prev) =>
        prev.map((r) =>
          r.id === rootId ? { ...r, tree: spliceSubtree(r.tree, path, children) } : r,
        ),
      );
    },
    [services],
  );

  // Keep open editors in sync with agent filesystem writes (Cursor-style).
  // Only hooks into the "agent" workspace; local folders never emit events.
  //
  // Trailing-edge debounced so a flurry of `file.changed` events from the
  // agent (e.g. a multi-file edit) collapses into a single `listTree` round
  // trip instead of N. The Monaco model contents are handled separately by
  // the SSE handler in `useLiveAgentEdits` (per-file `upsertModel`), so the
  // tree refresh here is purely for sidebar shape (adds/removes/renames).
  const refreshTreeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshAgentTree = useCallback(() => {
    if (refreshTreeTimerRef.current) clearTimeout(refreshTreeTimerRef.current);
    refreshTreeTimerRef.current = setTimeout(() => {
      refreshTreeTimerRef.current = null;
      void loadRoot("agent");
    }, 250);
  }, [loadRoot]);
  useEffect(() => {
    return () => {
      if (refreshTreeTimerRef.current) {
        clearTimeout(refreshTreeTimerRef.current);
        refreshTreeTimerRef.current = null;
      }
    };
  }, []);
  // Try to animate a live-edit in-place for the currently-active editor/file.
  // Returns true if the animation owned the content update (and React state
  // only needs savedContent/dirty updated), false otherwise.
  const tryAnimateLive = useCallback(
    (fileId: string, newContent: string): boolean => {
      const monaco = monacoNsRef.current;
      if (!monaco) return false;
      const g = groups.find((gg) => gg.activeId === fileId);
      if (!g) return false;
      const ed = editorRefs.current[g.id];
      if (!ed) return false;
      const model = ed.getModel();
      if (!model) return false;
      if (model.getValue() === newContent) return false;
      void applyAgentEdit(ed, monaco, newContent);
      return true;
    },
    [groups],
  );

  useLiveAgentEdits({
    service: services["agent"],
    setGroups,
    groups,
    activeGroupIdx,
    conflicts,
    setConflicts,
    refreshTree: refreshAgentTree,
    tryAnimate: tryAnimateLive,
    visible: paneVisible,
  });

  const handleReloadConflict = useCallback(
    (targetId: string) => {
      const c = conflicts.find((x) => x.fileId === targetId);
      if (!c) return;
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          files: g.files.map((f) =>
            f.id === targetId
              ? {
                  ...f,
                  content: c.incomingContent,
                  savedContent: c.incomingContent,
                  dirty: false,
                  error: undefined,
                }
              : f,
          ),
        })),
      );
      setConflicts((cs) => cs.filter((x) => x.fileId !== targetId));
    },
    [conflicts],
  );

  const handleKeepMine = useCallback((targetId: string) => {
    setConflicts((cs) => cs.filter((x) => x.fileId !== targetId));
  }, []);

  useEffect(() => {
    void loadRoot("agent");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `services` is seeded from the first `agentService` prop and was never
  // updated afterwards. IDEPanel upgrades SdkFs -> DesktopFs (IPC fast path)
  // asynchronously, and the runtime URL can change on restart, so follow the
  // prop and re-list the tree against the new backend.
  const lastAgentServiceRef = useRef(agentService);
  useEffect(() => {
    if (lastAgentServiceRef.current === agentService) return;
    lastAgentServiceRef.current = agentService;
    setServices((prev) => ({ ...prev, agent: agentService }));
  }, [agentService]);
  const loadedAgentServiceRef = useRef(services["agent"]);
  useEffect(() => {
    if (loadedAgentServiceRef.current === services["agent"]) return;
    loadedAgentServiceRef.current = services["agent"];
    void loadRoot("agent");
  }, [services, loadRoot]);

  // ─── Backend LSP wiring ────────────────────────────────────────────────
  // Once a Monaco editor mounts AND we have an agentUrl, register the
  // hover/completion/definition/references/rename providers and the
  // didOpen/didChange/didClose sync against the typescript-language-server
  // running in the agent runtime. Replaces the in-browser TS Web Worker as
  // the source of truth for cross-file IntelliSense — no client preload of
  // workspace files required because tsserver reads them off disk natively.
  useEffect(() => {
    const monaco = monacoNsRef.current;
    if (!monaco || !agentUrl) return;
    const providers = setupLspProviders({
      monaco: monaco as unknown as typeof import("monaco-editor"),
      agentUrl,
      rootId: "agent",
      fetchImpl,
    });
    const sync = setupLspDocumentSync({
      monaco: monaco as unknown as typeof import("monaco-editor"),
      agentUrl,
      rootId: "agent",
      fetchImpl,
    });
    return () => {
      providers.dispose();
      sync.dispose();
    };
  }, [monacoReadyTick, agentUrl, fetchImpl]);

  // ─── Fix-in-agent toast ─────────────────────────────────────────────
  // When the user clicks "✨ Fix with Shogo" in a Monaco hover or quick-fix,
  // agentFixProvider dispatches a window event carrying the diagnostic.
  // ChatPanel handles sending it to the agent; the IDE just flashes a toast
  // as immediate visual confirmation.
  useEffect(() => {
    const onFix = (e: Event) => {
      const detail = (e as CustomEvent<FixInAgentPayload>).detail;
      if (!detail) return;
      const file = detail.path.split("/").pop() || detail.path;
      showToast(`Sent to Shogo — fixing ${file}:${detail.line}`, 2200);
    };
    window.addEventListener(FIX_IN_AGENT_EVENT, onFix as EventListener);
    return () => window.removeEventListener(FIX_IN_AGENT_EVENT, onFix as EventListener);
  }, [showToast]);

  // ─── Local folder open/close ────────────────────────────────────────
  const mountLocalRoot = useCallback(
    async (id: string, label: string, handle: FileSystemDirectoryHandle) => {
      const svc = new LocalFs(id, label, handle);
      setServices((prev) => ({ ...prev, [id]: svc }));
      setRoots((prev) => {
        if (prev.some((r) => r.id === id)) return prev;
        return [
          ...prev,
          { id, label, kind: "local", tree: [], loading: true, error: null },
        ];
      });
      try {
        const raw = await svc.listTree("", 4);
        setRoot(id, { tree: annotateRoot(raw, id), loading: false });
        showToast(`Opened ${label}`);
      } catch (err) {
        setRoot(id, {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [setRoot, showToast],
  );

  const openLocalFolder = useCallback(async () => {
    if (!fsaSupported) {
      showToast("Your browser doesn't support local folder access (Chrome/Edge only)", 3500);
      return;
    }
    const handle = await pickDirectory();
    if (!handle) return;
    const id = `local:${handle.name}:${Date.now().toString(36)}`;
    await saveRoot(id, handle.name, handle);
    await mountLocalRoot(id, handle.name, handle);
  }, [fsaSupported, mountLocalRoot, showToast]);

  const closeRoot = useCallback(
    async (id: string) => {
      if (id === "agent") {
        showToast("Cannot close the agent workspace");
        return;
      }
      await deleteRoot(id).catch(() => {});
      disposeWorkspaceModels(id);
      setServices((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setRoots((prev) => prev.filter((r) => r.id !== id));
      // Close any open tabs from this root
      setGroups((prev) =>
        prev.map((g) => {
          const files = g.files.filter((f) => f.rootId !== id);
          return {
            ...g,
            files,
            activeId:
              g.activeId && g.files.find((f) => f.id === g.activeId)?.rootId === id
                ? files[0]?.id ?? null
                : g.activeId,
          };
        }),
      );
      showToast(`Closed folder`);
    },
    [showToast],
  );

  // Restore previously-opened local folders on mount (needs user permission)
  const restoreRoots = useCallback(async () => {
    try {
      const saved = await listRoots();
      for (const r of saved) {
        const ok = await ensurePermission(r.handle, "readwrite");
        if (ok) {
          await mountLocalRoot(r.id, r.label, r.handle);
          await touchRoot(r.id);
        }
      }
    } catch {
      /* ignore */
    }
  }, [mountLocalRoot]);

  // ─── Service routing helpers ────────────────────────────────────────
  const svcOf = useCallback((rootId: string) => services[rootId], [services]);

  // ─── Group helpers ──────────────────────────────────────────────────
  const updateGroup = useCallback(
    (idx: number, updater: (g: EditorGroup) => EditorGroup) => {
      setGroups((prev) => prev.map((g, i) => (i === idx ? updater(g) : g)));
    },
    [],
  );

  const findOpenLocation = useCallback(
    (id: string): { groupIdx: number; file: OpenFile } | null => {
      for (let i = 0; i < groups.length; i++) {
        const f = groups[i].files.find((x) => x.id === id);
        if (f) return { groupIdx: i, file: f };
      }
      return null;
    },
    [groups],
  );

  const openFileInGroup = useCallback(
    async (node: TreeNode, groupIdx: number) => {
      if (node.kind !== "file") return;
      const previewLang = previewLanguageFor(node.path);
      // Binary files without a dedicated preview can't be rendered by
      // Monaco — refuse to open. Files like .png/.pdf/.mp4/.sqlite ARE
      // binary but `previewLang` is non-null so we let them through to
      // the preview viewer below.
      if (!previewLang && isBinaryFilePath(node.path)) {
        showToast(`Cannot open binary file: ${node.name}`, 2500);
        return;
      }
      const id = fileId(node.rootId, node.path);
      const hit = findOpenLocation(id);
      if (hit) {
        setActiveGroupIdx(hit.groupIdx);
        updateGroup(hit.groupIdx, (g) => ({ ...g, activeId: id }));
        return;
      }
      const svc = svcOf(node.rootId);
      if (!svc) {
        showToast(`Unknown workspace: ${node.rootId}`, 2500);
        return;
      }
      const placeholder: OpenFile = {
        id,
        rootId: node.rootId,
        name: node.name,
        path: node.path,
        language: previewLang ?? node.language ?? "plaintext",
        content: "",
        savedContent: "",
        dirty: false,
        loading: true,
      };
      updateGroup(groupIdx, (g) => ({
        ...g,
        files: [...g.files, placeholder],
        activeId: id,
      }));
      setActiveGroupIdx(groupIdx);
      try {
        if (previewLang) {
          // Preview-language files (images, pdf, audio, video, fonts,
          // sqlite) never hit readFile() — that path is text-only and rejects
          // binaries. Instead we resolve a URL (blob: for local, http: for
          // the agent download endpoint) and stash it as the file content.
          // EditorGroupView routes by `language` and mounts the matching
          // preview component instead of Monaco.
          if (!svc.readFileUrl) {
            throw new Error(
              `${PREVIEW_LABEL[previewLang]} preview not supported for this workspace`,
            );
          }
          const url = await svc.readFileUrl(node.path);
          setGroups((prev) =>
            prev.map((g) => ({
              ...g,
              files: g.files.map((f) =>
                f.id === id
                  ? {
                      ...f,
                      content: url,
                      savedContent: url,
                      language: previewLang,
                      loading: false,
                    }
                  : f,
              ),
            })),
          );
          return;
        }
        const file = await svc.readFile(node.path);
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            files: g.files.map((f) =>
              f.id === id
                ? {
                    ...f,
                    content: file.content,
                    savedContent: file.content,
                    language: file.language,
                    loading: false,
                  }
                : f,
            ),
          })),
        );
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const is429 = /\b429\b/.test(raw) || /rate[_\s-]?limit/i.test(raw);
        const msg = is429
          ? "Rate limited — too many requests in a short time. Wait a few seconds and try again."
          : raw;
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            files: g.files.map((f) =>
              f.id === id ? { ...f, loading: false, error: msg } : f,
            ),
          })),
        );
      }
    },
    [findOpenLocation, svcOf, updateGroup, showToast],
  );

  const handleOpenFile = useCallback(
    (node: TreeNode) => {
      void openFileInGroup(node, activeGroupIdx);
    },
    [openFileInGroup, activeGroupIdx],
  );

  // ─── Session restore ─────────────────────────────────────────────────
  // Reopen the tabs the user had last time (paths only; content is re-read).
  // Runs once, after the project's own tree has loaded, and only when nothing
  // else (deep link / requestedFile) has already opened a file.
  // Warm Monaco (loader + editor.main) as soon as the IDE exists, so the first
  // file open doesn't wait on the editor bundle.
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (process.env.NODE_ENV === "test") return;
    preloadMonaco();
  }, []);

  const sessionReadyRef = useRef(false);
  useEffect(() => {
    if (sessionReadyRef.current) return;
    const agent = roots.find((r) => r.id === "agent");
    if (!agent || agent.loading) return;
    if (agent.error) {
      sessionReadyRef.current = true;
      return;
    }
    const session = loadSession(projectId);
    if (!sessionHasTabs(session) || requestedFile || groupsRef.current.some((g) => g.files.length > 0)) {
      sessionReadyRef.current = true;
      return;
    }
    void (async () => {
      setGroups(session.groups.map(() => ({ id: newGroupId(), files: [], activeId: null })));
      await Promise.all(
        session.groups.flatMap((g, gi) =>
          g.files.map((f) =>
            openFileInGroup(
              { kind: "file", rootId: f.rootId, path: f.path, name: f.path.split("/").pop() ?? f.path } as TreeNode,
              gi,
            ),
          ),
        ),
      );
      // Drop tabs whose file has since disappeared, then restore which tab /
      // group was focused (openFileInGroup activates whatever opened last).
      setGroups((prev) =>
        prev.map((g, gi) => {
          const files = g.files
            .filter((f) => !f.error)
            .map((f) => (session.groups[gi]?.files.find((x) => x.path === f.path)?.pinned ? { ...f, pinned: true } : f));
          const want = session.groups[gi]?.activeId;
          const activeId = files.some((f) => f.id === want) ? want! : files[files.length - 1]?.id ?? null;
          return { ...g, files, activeId };
        }),
      );
      setActiveGroupIdx(Math.min(session.activeGroupIdx, session.groups.length - 1));
      sessionReadyRef.current = true;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, projectId, requestedFile, openFileInGroup]);

  useEffect(() => {
    if (!sessionReadyRef.current) return;
    const t = window.setTimeout(() => {
      saveSession(projectId, snapshotSession(groups, activeGroupIdx));
    }, 400);
    return () => window.clearTimeout(t);
  }, [groups, activeGroupIdx, projectId]);

  // Open a workspace-relative path (used by the commit graph's file list).
  // Synthesizes a minimal file node against the primary (agent) root.
  const openWorkspaceFile = useCallback(
    (path: string) => {
      const rootId =
        roots.find((r) => r.kind === "agent")?.id ?? roots[0]?.id;
      if (!rootId) return;
      const name = path.split("/").pop() ?? path;
      setGraphOpen(false);
      void openFileInGroup(
        { kind: "file", rootId, path, name } as unknown as TreeNode,
        activeGroupIdx,
      );
    },
    [roots, openFileInGroup, activeGroupIdx],
  );

  const appliedRequestedFileNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!requestedFile) return;
    // Requests carrying a line are handled by the reveal effect below.
    if (requestedFile.line != null) return;
    if (appliedRequestedFileNonce.current === requestedFile.nonce) return;
    const rootId = roots.find((r) => r.kind === "agent")?.id ?? roots[0]?.id;
    if (!rootId) return;
    appliedRequestedFileNonce.current = requestedFile.nonce;
    openWorkspaceFile(requestedFile.path);
  }, [requestedFile, roots, openWorkspaceFile]);

  const handleSetMdMode = useCallback((fileId: string, mode: "preview" | "edit") => {
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        files: g.files.map((f) => (f.id === fileId ? { ...f, mdMode: mode } : f)),
      })),
    );
  }, []);

  // BUG-001 fix: route the change by the explicit `fileId` carried out of
  // CodeEditor (which derived it from the live Monaco model URI), NOT by
  // the group's currently-tracked `activeId`. The old code matched on
  // `f.id === g.activeId`, which on a rapid tab swap could land the
  // previous tab's last keystroke in the newly-active tab (because React
  // had already advanced `activeId` while Monaco was still firing for the
  // outgoing model). `applyEditorChange` is the pure resolver — it ignores
  // activeId entirely, drops no-op flushes, and treats a missing fileId
  // (closed mid-flight) as a no-op without re-rendering.
  //
  // A file open in both split groups shares ONE Monaco model (same path
  // URI), so a change must land in every group that holds the file. Updating
  // only the originating group left the other group's `content`/`dirty`
  // stale, and Save could then write the stale copy.
  const handleChangeFor = (_groupIdx: number) => (fileId: string, val: string) => {
    setGroups((prev) => {
      let changed = false;
      const next = prev.map((g) => {
        const ng = applyEditorChange(g, fileId, val);
        if (ng !== g) changed = true;
        return ng;
      });
      return changed ? next : prev;
    });
  };

  // Closes a tab without any prompt. Use `closeInGroup` (defined after the
  // save pipeline) for user-initiated closes — it asks about unsaved changes.
  const closedStackRef = useRef<Array<{ rootId: string; path: string; name: string }>>([]);
  const closeNow = useCallback((groupIdx: number, id: string) => {
    // Remember it for "Reopen Closed Editor" (⌘⇧T).
    const closing = groupsRef.current[groupIdx]?.files.find((x) => x.id === id);
    if (closing && !closing.language.startsWith("extension-")) {
      const stack = closedStackRef.current;
      stack.push({ rootId: closing.rootId, path: closing.path, name: closing.name });
      if (stack.length > 20) stack.shift();
    }
    // Closing a conflicted tab discards the banner for that file.
    setConflicts((cs) => cs.filter((c) => c.fileId !== id));
    setGroups((prev) => {
      const g = prev[groupIdx];
      if (!g) return prev;
      const idx = g.files.findIndex((f) => f.id === id);
      if (idx < 0) return prev;
      const f = g.files[idx];
      // Preview tabs (image/sqlite/pdf/audio/video/font) allocate a blob:
      // URL on open — revoke it on close so long browsing sessions don't
      // leak one per file opened.
      if (
        PREVIEW_LANGUAGES.has(f.language) &&
        f.content.startsWith("blob:")
      ) {
        try { URL.revokeObjectURL(f.content); } catch { /* ignore */ }
      }
      const nextFiles = g.files.filter((x) => x.id !== id);
      const nextActive =
        g.activeId === id ? nextFiles[Math.max(0, idx - 1)]?.id ?? null : g.activeId;
      if (nextFiles.length === 0 && prev.length > 1 && groupIdx > 0) {
        const without = prev.filter((_, i) => i !== groupIdx);
        setActiveGroupIdx((ai) => Math.min(ai, without.length - 1));
        return without;
      }
      return prev.map((gg, i) => (i === groupIdx ? { ...gg, files: nextFiles, activeId: nextActive } : gg));
    });
  }, []);

  const reorderInGroup = useCallback(
    (groupIdx: number, orderedIds: string[]) => {
      setGroups((prev) =>
        prev.map((g, i) => {
          if (i !== groupIdx) return g;
          const byId = new Map(g.files.map((f) => [f.id, f]));
          const nextFiles: OpenFile[] = [];
          for (const id of orderedIds) {
            const f = byId.get(id);
            if (f) {
              nextFiles.push(f);
              byId.delete(id);
            }
          }
          // Append any files that weren't in the provided order (shouldn't
          // happen, but keeps state consistent).
          for (const f of byId.values()) nextFiles.push(f);
          return { ...g, files: nextFiles };
        }),
      );
    },
    [],
  );

  const togglePinInGroup = useCallback((groupIdx: number, id: string) => {
    setGroups((prev) =>
      prev.map((g, i) =>
        i === groupIdx
          ? { ...g, files: g.files.map((f) => (f.id === id ? { ...f, pinned: !f.pinned } : f)) }
          : g,
      ),
    );
  }, []);

  // ─── CRUD via service routing ───────────────────────────────────────
  const handleCreate = useCallback(
    async (rootId: string, parentPath: string, name: string, kind: "file" | "dir") => {
      const svc = svcOf(rootId);
      if (!svc) return;
      const full = parentPath ? `${parentPath}/${name}` : name;
      try {
        if (kind === "dir") await svc.mkdir(full);
        else await svc.writeFile(full, "");
        showToast(kind === "dir" ? `Created folder ${name}` : `Created ${name}`);
        await loadRoot(rootId);
        // Like every editor: a freshly created file opens ready to type in.
        if (kind === "file") {
          void openFileInGroup(
            { kind: "file", rootId, path: full, name } as unknown as TreeNode,
            activeGroupIdx,
          );
        }
      } catch (err) {
        showToast(`Create failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      }
    },
    [svcOf, loadRoot, showToast, openFileInGroup, activeGroupIdx],
  );

  const rewriteOpenPaths = (rootId: string, from: string, to: string) => {
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        activeId: (() => {
          if (!g.activeId) return g.activeId;
          const f = g.files.find((x) => x.id === g.activeId);
          if (!f || f.rootId !== rootId) return g.activeId;
          if (f.path === from) return fileId(rootId, to);
          if (f.path.startsWith(from + "/")) return fileId(rootId, to + f.path.slice(from.length));
          return g.activeId;
        })(),
        files: g.files.map((f) => {
          if (f.rootId !== rootId) return f;
          if (f.path === from) {
            // Renaming `a.txt` → `a.ts` must also switch syntax highlighting.
            // (Preview files hold a blob URL, not text — leave those alone.)
            const language =
              f.loading || f.error || previewLanguageFor(from) || previewLanguageFor(to)
                ? f.language
                : languageFor(to);
            return { ...f, id: fileId(rootId, to), path: to, name: to.split("/").pop() ?? to, language };
          }
          if (f.path.startsWith(from + "/")) {
            const np = to + f.path.slice(from.length);
            return { ...f, id: fileId(rootId, np), path: np };
          }
          return f;
        }),
      })),
    );
  };

  const removeOpenPaths = (rootId: string, prefix: string) => {
    setGroups((prev) =>
      prev.map((g) => {
        const files = g.files.filter(
          (f) => !(f.rootId === rootId && (f.path === prefix || f.path.startsWith(prefix + "/"))),
        );
        return {
          ...g,
          files,
          activeId:
            g.activeId && !files.find((f) => f.id === g.activeId) ? files[0]?.id ?? null : g.activeId,
        };
      }),
    );
  };

  const handleRenameNode = useCallback(
    async (node: TreeNode, newName: string) => {
      const svc = svcOf(node.rootId);
      if (!svc) return;
      const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
      const to = parent ? `${parent}/${newName}` : newName;
      try {
        await svc.rename(node.path, to);
        // Drop the OLD model — loadRoot below will upsert the new path.
        if (node.kind === "dir") {
          removeModelsUnderPath(node.rootId, node.path);
        } else {
          removeModel(node.rootId, node.path);
        }
        showToast(`Renamed to ${newName}`);
        rewriteOpenPaths(node.rootId, node.path, to);
        await loadRoot(node.rootId);
      } catch (err) {
        showToast(`Rename failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      }
    },
    [svcOf, loadRoot, showToast],
  );

  const handleDeleteNode = useCallback(
    async (node: TreeNode) => {
      const svc = svcOf(node.rootId);
      if (!svc) return;
      // Deleting something that has unsaved edits open would silently throw
      // those edits away — the tree's own confirm only mentions the file.
      const dirtyOpen = groupsRef.current
        .flatMap((g) => g.files)
        .filter(
          (f) =>
            f.dirty &&
            f.rootId === node.rootId &&
            (f.path === node.path || f.path.startsWith(node.path + "/")),
        );
      if (dirtyOpen.length > 0) {
        const names = [...new Set(dirtyOpen.map((f) => f.name))];
        const choice = await askConfirm({
          title: "Delete files with unsaved changes?",
          message: `${describeFileNames(names)} ${names.length === 1 ? "has" : "have"} unsaved changes that will be lost.`,
          buttons: [
            { label: "Cancel", value: "cancel" as const, variant: "primary" },
            { label: "Delete", value: "delete" as const, variant: "danger" },
          ],
          cancelValue: "cancel" as const,
        });
        if (choice !== "delete") return;
      }
      try {
        await svc.remove(node.path);
        // Drop the Monaco model(s) so go-to-def / hover don't keep resolving
        // against deleted files. Files use removeModel; folders need a
        // prefix sweep to drop every nested file's model.
        if (node.kind === "dir") {
          removeModelsUnderPath(node.rootId, node.path);
        } else {
          removeModel(node.rootId, node.path);
        }
        showToast(`Deleted ${node.name}`);
        removeOpenPaths(node.rootId, node.path);
        await loadRoot(node.rootId);
      } catch (err) {
        showToast(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      }
    },
    [svcOf, loadRoot, showToast, askConfirm],
  );

  const handleMove = useCallback(
    async (from: TreeNode, toDir: TreeNode | null) => {
      if (toDir && from.rootId !== toDir.rootId) {
        showToast("Cross-workspace move not supported", 2500);
        return;
      }
      const svc = svcOf(from.rootId);
      if (!svc) return;
      const targetDir = toDir?.path ?? "";
      const currentParent = from.path.includes("/") ? from.path.slice(0, from.path.lastIndexOf("/")) : "";
      if (targetDir === currentParent) return;
      if (targetDir === from.path || targetDir.startsWith(from.path + "/")) {
        showToast("Can't move folder into itself", 2500);
        return;
      }
      const to = targetDir ? `${targetDir}/${from.name}` : from.name;
      try {
        await svc.rename(from.path, to);
        // Drop the OLD model — loadRoot below will upsert the new path.
        if (from.kind === "dir") {
          removeModelsUnderPath(from.rootId, from.path);
        } else {
          removeModel(from.rootId, from.path);
        }
        showToast(`Moved ${from.name}`);
        rewriteOpenPaths(from.rootId, from.path, to);
        await loadRoot(from.rootId);
      } catch (err) {
        showToast(`Move failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      }
    },
    [svcOf, loadRoot, showToast],
  );

  // Download a file via the workspace service's authed blob fetch (same path
  // as binary previews). We fetch to a blob: URL rather than linking the agent
  // download endpoint directly so the `download` attribute is always honored
  // (blob: is same-origin) and the IDE never navigates away — the runtime
  // serves images/pdf with `Content-Disposition: inline`. Web only.
  const handleDownload = useCallback(
    async (node: TreeNode) => {
      if (node.kind !== "file" || typeof document === "undefined") return;
      const svc = svcOf(node.rootId);
      if (!svc) {
        showToast(`Unknown workspace: ${node.rootId}`, 2500);
        return;
      }
      if (!svc.readFileUrl) {
        showToast("Download not supported for this workspace", 2500);
        return;
      }
      let url: string | null = null;
      try {
        url = await svc.readFileUrl(node.path);
        const a = document.createElement("a");
        a.href = url;
        a.download = node.name;
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {
        showToast(`Download failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      } finally {
        // Defer revocation so the browser has started the download before the
        // blob: URL is released.
        if (url) {
          const toRevoke = url;
          setTimeout(() => URL.revokeObjectURL(toRevoke), 1000);
        }
      }
    },
    [svcOf, showToast],
  );

  /**
   * Open the Search view. With an editor selection (single line) or a word
   * under the cursor the query is pre-filled, like VS Code's
   * `editor.find.seedSearchStringFromSelection`.
   */
  const openSearchImpl = (opts: { include?: string; query?: string } = {}) => {
    let query = opts.query;
    if (query === undefined) {
      const ed = editorRefs.current[activeGroup?.id ?? ""];
      const model = ed?.getModel();
      const sel = ed?.getSelection();
      if (ed && model && sel) {
        if (!sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) {
          query = model.getValueInRange(sel);
        } else if (sel.isEmpty()) {
          const word = model.getWordAtPosition(sel.getPosition());
          if (word) query = word.word;
        }
      }
    }
    setSearchSeed({ query, include: opts.include, nonce: Date.now() });
    setActivity("search");
    setSidebarOpen(true);
  };
  // Stable wrapper: memoised command lists / key handlers always reach the
  // latest closure (current active group) through the ref.
  const openSearchRef = useRef(openSearchImpl);
  openSearchRef.current = openSearchImpl;
  const openSearch = useCallback(
    (opts?: { include?: string; query?: string }) => openSearchRef.current(opts),
    [],
  );

  const handleCopy = useCallback(
    async (from: TreeNode, toRootId: string, toDirPath: string, newName: string) => {
      if (from.rootId !== toRootId) {
        showToast("Cross-workspace copy not supported", 2500);
        return;
      }
      const svc = svcOf(from.rootId);
      if (!svc?.copy) {
        showToast("Copy not supported for this workspace", 2500);
        return;
      }
      if (toDirPath === from.path || toDirPath.startsWith(from.path + "/")) {
        showToast("Can't copy a folder into itself", 2500);
        return;
      }
      const to = toDirPath ? `${toDirPath}/${newName}` : newName;
      try {
        await svc.copy(from.path, to);
        showToast(`Copied to ${newName}`);
        await loadRoot(from.rootId);
      } catch (err) {
        showToast(`Copy failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      }
    },
    [svcOf, loadRoot, showToast],
  );

  /** Explorer "Open to the Side": the other group, creating the split if needed. */
  const openToSide = useCallback(
    (node: TreeNode) => {
      if (node.kind !== "file") return;
      let target: number;
      if (groupsRef.current.length < 2) {
        setGroups((prev) => (prev.length < 2 ? [...prev, { id: newGroupId(), files: [], activeId: null }] : prev));
        target = 1;
      } else {
        target = activeGroupIdx === 0 ? 1 : 0;
      }
      void openFileInGroup(node, target);
    },
    [activeGroupIdx, openFileInGroup],
  );

  const treeHandlers: FileTreeHandlers = useMemo(
    () => ({
      onOpen: handleOpenFile,
      onCreate: handleCreate,
      onRename: handleRenameNode,
      onDelete: handleDeleteNode,
      onMove: handleMove,
      onDownload: handleDownload,
      onLoadSubtree: loadSubtree,
      onCopy: handleCopy,
      onOpenToSide: openToSide,
      onFindInFolder: (node) =>
        openSearch({ include: node.isRoot ? "" : node.path, query: undefined }),
      absolutePath: (node) => {
        const root = gitWorkspaceRootRef.current;
        if (!root || node.rootId !== "agent") return null;
        return node.path ? workspaceFsPath(root, node.path) : root;
      },
    }),
    [handleOpenFile, handleCreate, handleRenameNode, handleDeleteNode, handleMove, handleDownload, loadSubtree, handleCopy, openToSide, openSearch],
  );

  // ─── Save ────────────────────────────────────────────────────────────
  // BUG-003 fix: every save-time operation resolves through the file's
  // STABLE id, captured at invocation. We never read `active` here, never
  // call `editor.getActiveModel()`, never trust a closure capture. The
  // file id is the safe key:
  //
  //   1. resolveSaveTarget(groupsRef.current, id)  — latest snapshot from
  //      the live ref, not a render-tick-stale closure;
  //   2. findEditorForFileId(editorRefs, id)       — the editor whose
  //      attached model has THIS file's URI, so format-on-save's
  //      formatDocument runs against the right document (and therefore
  //      against the right JSON-schema fileMatch, fixing the canvas-
  //      reported "schema validation runs against wrong file" symptom).
  const persistByFileId = useCallback(
    async (id: string, opts?: { silent?: boolean; auto?: boolean }): Promise<boolean> => {
      const f = resolveSaveTarget(groupsRef.current, id);
      if (!f) return false; // closed mid-flight — drop silently
      const svc = svcOf(f.rootId);
      if (!svc) return false;

      let content = f.content;
      // Format-on-save: locate the editor whose model is THIS file (never
      // the "active" model — which is racy across tab swaps and ambiguous
      // across split groups), then trigger the formatter through it. After
      // the formatter applied edits, read the final content from the model
      // — the React-state `content` is one keystroke stale by then.
      // Like VS Code, formatting/whitespace clean-up only runs on explicit
      // saves — never on the autosave that fires while you pause typing
      // (it would rewrite the line under your cursor mid-thought).
      const wantsCleanup =
        !opts?.auto &&
        (settings.formatOnSave || settings.trimTrailingWhitespace || settings.insertFinalNewline);
      if (wantsCleanup) {
        const ed = findEditorForFileId(Object.values(editorRefs.current), id);
        if (ed) {
          try {
            if (settings.formatOnSave) {
              const action = ed.getAction?.("editor.action.formatDocument");
              if (action) await action.run();
            }
            if (settings.trimTrailingWhitespace) {
              await ed.getAction?.("editor.action.trimTrailingWhitespace")?.run();
            }
            const m = ed.getModel();
            if (m && settings.insertFinalNewline) {
              const last = m.getLineCount();
              if (m.getLineContent(last) !== "") {
                ed.executeEdits("shogo.insertFinalNewline", [
                  {
                    range: {
                      startLineNumber: last,
                      startColumn: m.getLineMaxColumn(last),
                      endLineNumber: last,
                      endColumn: m.getLineMaxColumn(last),
                    },
                    text: "\n",
                  },
                ]);
              }
            }
            if (m) content = m.getValue();
          } catch {
            // Format failures must NEVER block the save — log via toast
            // only when not silent, then proceed with the unformatted
            // content (matches VS Code's behaviour).
            if (!opts?.silent) showToast("Format on save failed; saving unformatted", 2500);
          }
        }
      }

      try {
        await svc.writeFile(f.path, content);
        let applied = false;
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            files: g.files.map((x) => {
              if (x.id !== id) return x;
              // If the user kept typing between the format step and the
              // setState, `x.content` may be ahead of the `content` we
              // wrote to disk. Don't clobber the dirty flag in that case
              // — the file is still dirty until the LATEST content lands.
              if (x.content !== content) return x;
              applied = true;
              return { ...x, dirty: false, savedContent: content };
            }),
          })),
        );
        if (applied) setConflicts((cs) => cs.filter((c) => c.fileId !== id));
        const root = gitWorkspaceRootRef.current;
        if (root) {
          const gitBridge = getDesktopGitBridge();
          void gitBridge?.refresh(root);
          void maybeAutoStageIfConflictResolved(root, f.path, content).finally(() => {
            void gitBridge?.refresh(root);
          });
        }
        if (!opts?.silent) showToast(`Saved ${f.name}`);
        return true;
      } catch (err) {
        showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
        return false;
      }
    },
    [svcOf, showToast, settings.formatOnSave, settings.trimTrailingWhitespace, settings.insertFinalNewline],
  );

  // Compat shim: a couple of older call sites (autosave timer, merge editor)
  // still pass an OpenFile snapshot. Route them through persistByFileId
  // using the id — `f.id` is stable across React renders even if `f` itself
  // is a stale snapshot, so the resolver still ends up reading the latest
  // content from groupsRef.
  const persistOpenFile = useCallback(
    (f: OpenFile, silent?: boolean): Promise<boolean> =>
      persistByFileId(f.id, { silent, auto: !!silent }),
    [persistByFileId],
  );

  const handleSave = useCallback(async () => {
    // Capture activeId at invocation (NOT active itself — that's the React
    // render's closure). The actual file is resolved from groupsRef inside
    // persistByFileId, so this stays correct even if the user has swapped
    // tabs since Cmd+S was pressed (their intent was to save what was
    // active when they pressed the key).
    const id = active?.id;
    if (!id) return;
    const f = resolveSaveTarget(groupsRef.current, id);
    if (!f?.dirty) return;
    await persistByFileId(id);
  }, [active?.id, persistByFileId]);

  const handleSaveAll = useCallback(async () => {
    // Read directly from the live ref so we see the same set every render
    // would see — and dedupe by id (same file open in two split groups
    // must not be written twice).
    const dirty = collectDirtyFiles(groupsRef.current);
    if (!dirty.length) {
      showToast("Nothing to save");
      return;
    }
    const results = await Promise.all(
      dirty.map((f) => persistByFileId(f.id, { silent: true })),
    );
    const failed = results.filter((ok) => !ok).length;
    if (failed === 0) {
      showToast(`Saved ${dirty.length} file${dirty.length === 1 ? "" : "s"}`);
    } else {
      showToast(`Saved ${dirty.length - failed} of ${dirty.length} files — ${failed} failed`, 3500);
    }
  }, [persistByFileId, showToast]);

  // User-initiated tab close: asks Save / Don't Save / Cancel when the file
  // has unsaved edits (unless it's still open in another group, where the
  // shared buffer isn't going away).
  const closeInGroup = useCallback(
    async (groupIdx: number, id: string): Promise<boolean> => {
      const groups = groupsRef.current;
      const f = groups[groupIdx]?.files.find((x) => x.id === id);
      if (!f) return true;
      const openElsewhere = groups.some(
        (g, i) => i !== groupIdx && g.files.some((x) => x.id === id),
      );
      if (f.dirty && !openElsewhere) {
        const choice = await askConfirm({
          title: `Do you want to save the changes you made to ${f.name}?`,
          message: "Your changes will be lost if you don't save them.",
          buttons: [
            { label: "Don't Save", value: "discard" as const, variant: "secondary" },
            { label: "Cancel", value: "cancel" as const, variant: "secondary" },
            { label: "Save", value: "save" as const, variant: "primary" },
          ],
          cancelValue: "cancel" as const,
        });
        if (choice === "cancel") return false;
        if (choice === "save") {
          const ok = await persistByFileId(id, { silent: true });
          // A failed save already toasted; keep the tab so nothing is lost.
          if (!ok) return false;
        }
      }
      closeNow(groupIdx, id);
      return true;
    },
    [askConfirm, persistByFileId, closeNow],
  );

  /** Close several tabs in order; stops at the first one the user cancels. */
  const closeManyInGroup = useCallback(
    async (groupIdx: number, ids: string[]) => {
      for (const id of ids) {
        if (!(await closeInGroup(groupIdx, id))) return;
      }
    },
    [closeInGroup],
  );

  const reopenClosed = useCallback(() => {
    const entry = closedStackRef.current.pop();
    if (!entry) {
      showToast("No recently closed editors", 1500);
      return;
    }
    void openFileInGroup(
      { kind: "file", rootId: entry.rootId, path: entry.path, name: entry.name } as unknown as TreeNode,
      activeGroupIdx,
    );
  }, [openFileInGroup, activeGroupIdx, showToast]);

  // Explorer reveal: switch to the Files view and ask the tree to select + scroll.
  const [revealReq, setRevealReq] = useState<{ path: string; nonce: number } | null>(null);
  const revealInExplorer = useCallback((path: string) => {
    setActivity("files");
    setSidebarOpen(true);
    setRevealReq({ path, nonce: Date.now() });
  }, []);

  const copyText = useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(`Copied ${what}`, 1500);
      } catch {
        showToast("Couldn't access the clipboard", 2500);
      }
    },
    [showToast],
  );

  // "Retry" on a file that failed to open: drop the broken tab and reopen it.
  const retryOpen = useCallback(
    (groupIdx: number, id: string) => {
      const f = groupsRef.current[groupIdx]?.files.find((x) => x.id === id);
      if (!f) return;
      closeNow(groupIdx, id);
      void openFileInGroup(
        { kind: "file", rootId: f.rootId, path: f.path, name: f.name } as unknown as TreeNode,
        groupIdx,
      );
    },
    [closeNow, openFileInGroup],
  );

  // Auto save: debounce while typing; flush when switching away from a tab.
  useEffect(() => {
    const curId = active?.id ?? null;
    const prevId = prevActiveIdForAutosaveRef.current;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (settings.autoSave && prevId && prevId !== curId) {
      const prevFile = groupsRef.current.flatMap((g) => g.files).find((x) => x.id === prevId);
      if (prevFile?.dirty) void persistOpenFile(prevFile, true);
    }
    prevActiveIdForAutosaveRef.current = curId;
  }, [active?.id, settings.autoSave, persistOpenFile]);

  useEffect(() => {
    if (!settings.autoSave || !active?.dirty) {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      return;
    }
    const snapshot = active;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void persistOpenFile(snapshot, true);
    }, settings.autoSaveDelay ?? AUTO_SAVE_DELAY_MS);
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [active, active?.content, active?.dirty, settings.autoSave, settings.autoSaveDelay, persistOpenFile]);

  // ─── Splits ──────────────────────────────────────────────────────────
  const splitRight = useCallback(() => {
    if (groups.length >= 2) {
      showToast("Already split — close a group first (max 2)", 2000);
      return;
    }
    if (!active) {
      showToast("Open a file first");
      return;
    }
    const cloned: OpenFile = { ...active, pinned: false };
    setGroups((prev) => [...prev, { id: newGroupId(), files: [cloned], activeId: cloned.id }]);
    setActiveGroupIdx(groups.length);
  }, [groups.length, active, showToast]);

  const closeOtherGroup = useCallback(() => {
    setGroups((prev) => (prev.length < 2 ? prev : [prev[activeGroupIdx]]));
    setActiveGroupIdx(0);
  }, [activeGroupIdx]);

  const focusNextGroup = useCallback(() => {
    if (groups.length < 2) return;
    setActiveGroupIdx((i) => (i + 1) % groups.length);
  }, [groups.length]);

  const gotoLine = useCallback(
    (line: number) => {
      const ed = editorRefs.current[activeGroup?.id ?? ""];
      if (!ed) return;
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: 1 });
      ed.focus();
    },
    [activeGroup],
  );


  // Reveal a specific location across any root (used by project search)
  const revealMatch = useCallback(
    async (rootId: string, path: string, line: number, col: number) => {
      // Find the file node in the tree to open it through the usual path
      const findIn = (nodes: TreeNode[]): TreeNode | null => {
        for (const n of nodes) {
          if (n.kind === "file" && n.path === path && n.rootId === rootId) return n;
          if (n.children) {
            const hit = findIn(n.children);
            if (hit) return hit;
          }
        }
        return null;
      };
      const root = roots.find((r) => r.id === rootId);
      let node = root ? findIn(root.tree) : null;
      if (!node) {
        node = {
          name: path.split("/").pop() ?? path,
          path,
          kind: "file",
          rootId,
          language: "plaintext",
        };
      }
      await openFileInGroup(node, activeGroupIdx);
      // Give Monaco a tick to mount the new model before revealing
      window.setTimeout(() => {
        const ed = editorRefs.current[activeGroup?.id ?? ""];
        if (!ed) return;
        ed.revealPositionInCenter({ lineNumber: line, column: col });
        ed.setPosition({ lineNumber: line, column: col });
        ed.focus();
      }, 80);
    },
    [roots, openFileInGroup, activeGroupIdx, activeGroup],
  );

  // "Go to file:line:col" requests from outside the IDE (Problems panel in
  // the project-level drawer).
  const appliedRevealNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!requestedFile || requestedFile.line == null) return;
    if (appliedRevealNonce.current === requestedFile.nonce) return;
    const rootId = roots.find((r) => r.kind === "agent")?.id ?? roots[0]?.id;
    if (!rootId) return;
    appliedRevealNonce.current = requestedFile.nonce;
    void revealMatch(rootId, requestedFile.path, requestedFile.line, requestedFile.column ?? 1);
  }, [requestedFile, roots, revealMatch]);

  const extensionsSummary = useExtensions({ workspaceRoot: gitWorkspaceRootRef.current });
  const extensionRuntimeContainers = useMemo(
    () => collectRuntimeContainers(extensionsSummary.installed),
    [extensionsSummary.installed],
  );
  const activityBarExtensionContainers = useMemo(
    () => extensionRuntimeContainers.filter((container) => container.location === "activitybar"),
    [extensionRuntimeContainers],
  );
  const panelExtensionContainers = useMemo(
    () => extensionRuntimeContainers.filter((container) => container.location === "panel"),
    [extensionRuntimeContainers],
  );
  useEffect(() => {
    ideBottomPanelStore.setExtensionPanelContainers(panelExtensionContainers.map((container) => ({
      ...container,
      location: "panel" as const,
      workspaceRoot: gitWorkspaceRootRef.current ?? null,
    })));
  }, [panelExtensionContainers]);
  const activeExtensionRuntimeContainer = useMemo(
    () => extensionRuntimeContainers.find((container) => container.activityId === activity),
    [activity, extensionRuntimeContainers],
  );
  const openExtensionDetailsTab = useCallback((item: InstalledExtension | ExtensionSearchResult) => {
    const id = `extension:${item.id}`;
    const name = `Extension: ${item.displayName || item.name}`;
    const existing = findOpenLocation(id);
    if (existing) {
      setActiveGroupIdx(existing.groupIdx);
      updateGroup(existing.groupIdx, (g) => ({
        ...g,
        activeId: id,
        files: g.files.map((file) => file.id === id ? { ...file, name, extensionDetail: item } : file),
      }));
      return;
    }
    const tab: OpenFile = {
      id,
      rootId: "__extensions__",
      name,
      path: `Extensions/${item.displayName || item.name}`,
      language: "extension-detail",
      content: "",
      savedContent: "",
      dirty: false,
      extensionDetail: item,
    };
    updateGroup(activeGroupIdx, (g) => ({ ...g, files: [...g.files, tab], activeId: id }));
    setActiveGroupIdx(activeGroupIdx);
  }, [activeGroupIdx, findOpenLocation, updateGroup]);

  /** Source Control → click a change: open (or focus) a real diff tab. */
  const openGitDiffTab = useCallback(
    (path: string, group: "staged" | "changes", workspaceRoot: string) => {
      const id = `git-diff:${group}:${path}`;
      const name = `${path.split("/").pop() ?? path} (${group === "staged" ? "Index" : "Working Tree"})`;
      const existing = findOpenLocation(id);
      if (existing) {
        setActiveGroupIdx(existing.groupIdx);
        updateGroup(existing.groupIdx, (g) => ({ ...g, activeId: id }));
        return;
      }
      const tab: OpenFile = {
        id,
        rootId: "__git-diff__",
        name,
        path,
        language: "git-diff",
        content: "",
        savedContent: "",
        dirty: false,
        gitDiff: { workspaceRoot, path, group },
      };
      updateGroup(activeGroupIdx, (g) => ({ ...g, files: [...g.files, tab], activeId: id }));
      setActiveGroupIdx(activeGroupIdx);
    },
    [activeGroupIdx, findOpenLocation, updateGroup],
  );

  const openExtensionWebviewPanel = useCallback((panel: ExtensionRuntimeWebviewPanel) => {
    const id = `extension-webview:${panel.id}`;
    const existing = findOpenLocation(id);
    const tabName = panel.title || panel.viewType || "Extension Webview";
    if (existing) {
      setActiveGroupIdx(existing.groupIdx);
      updateGroup(existing.groupIdx, (g) => ({
        ...g,
        activeId: id,
        files: g.files.map((file) => file.id === id ? { ...file, name: tabName, content: panel.html, savedContent: panel.html } : file),
      }));
      return;
    }
    const tab: OpenFile = {
      id,
      rootId: "__extensions__",
      name: tabName,
      path: `Extensions/${panel.extensionId}/${panel.viewType}`,
      language: "extension-webview",
      content: panel.html,
      savedContent: panel.html,
      dirty: false,
    };
    updateGroup(activeGroupIdx, (g) => ({ ...g, files: [...g.files, tab], activeId: id }));
    setActiveGroupIdx(activeGroupIdx);
  }, [activeGroupIdx, findOpenLocation, updateGroup]);

  const requestExtensionInstall = useCallback((item: InstalledExtension | ExtensionSearchResult) => {
    if (extensionsSummary.isPublisherTrusted(item.publisher)) {
      void extensionsSummary.installFromRegistry(item.id, item.version);
    } else {
      setPendingExtensionInstall(item);
    }
  }, [extensionsSummary]);
  const trustAndInstallExtension = useCallback(async () => {
    if (!pendingExtensionInstall) return;
    const trusted = await extensionsSummary.trustPublisher(pendingExtensionInstall.publisher);
    if (!trusted) return;
    void extensionsSummary.installFromRegistry(pendingExtensionInstall.id, pendingExtensionInstall.version);
    setPendingExtensionInstall(null);
  }, [extensionsSummary, pendingExtensionInstall]);
  const runExtensionCommand = useCallback((commandId: string, args?: unknown[]) => {
    const bridge = getDesktopExtensionsBridge();
    if (!bridge) {
      showToast("Extension commands are available in Shogo Desktop only", 2500);
      return;
    }
    showToast(`Running ${commandId}…`, 1600);
    void bridge.runCommand(commandId, args ?? [], gitWorkspaceRootRef.current ?? undefined).then(async (response) => {
      if (!response.ok) {
        const message = response.error ?? `Extension command failed: ${commandId}`;
        console.warn(message);
        showToast(message, 3500);
        void extensionsSummary.showRunningExtensions();
        return;
      }
      showToast(`Command completed: ${commandId}`, 2200);
      void extensionsSummary.showRunningExtensions();
      void extensionsSummary.loadStatusBarItems();
      const panels = await bridge.getWebviewPanels(gitWorkspaceRootRef.current ?? undefined);
      if (panels.ok) {
        for (const panel of panels.panels ?? []) openExtensionWebviewPanel(panel);
      }
    });
  }, [extensionsSummary, openExtensionWebviewPanel, showToast]);
  const loadExtensionRuntimeView = useCallback(async (viewId: string, itemHandle?: string): Promise<ExtensionRuntimeViewResult | null> => {
    const bridge = getDesktopExtensionsBridge();
    if (!bridge) return null;
    const response = await bridge.getView(viewId, gitWorkspaceRootRef.current ?? undefined, itemHandle);
    if (!response.ok) throw new Error(response.error ?? `Extension view failed: ${viewId}`);
    void extensionsSummary.showRunningExtensions();
    return response.view ?? null;
  }, [extensionsSummary]);

  const useExtensionEntryPoint = useCallback((extension: InstalledExtension, entryPoint: ExtensionUsableEntryPoint) => {
    if (!extension.enabled) {
      showToast(`${extension.displayName || extension.name} is disabled`, 2500);
      return;
    }
    if (extension.supportStatus !== "supported" && extension.supportStatus !== "partial") {
      showToast(extension.unsupportedSurfaceMessage ?? extension.supportStatusMessage, 4500);
      return;
    }
    if (entryPoint.kind === "command") {
      runExtensionCommand(entryPoint.id);
      return;
    }
    const containerId = entryPoint.kind === "view" ? entryPoint.detail : entryPoint.id;
    const container = extensionRuntimeContainers.find((candidate) => candidate.extension.id === extension.id && candidate.id === containerId);
    if (container) {
      if (container.location === "panel") {
        ideBottomPanelStore.showExtensionPanelContainer(container.activityId);
      } else {
        setActivity(container.activityId);
        if (!sidebarOpen) setSidebarOpen(true);
      }
      if (entryPoint.kind === "view") {
        const bridge = getDesktopExtensionsBridge();
        void bridge?.activateEvent(`onView:${entryPoint.id}`, gitWorkspaceRootRef.current ?? undefined).then(() => {
          void extensionsSummary.showRunningExtensions();
        });
      }
      return;
    }
    if (entryPoint.kind === "startupActivation") {
      const bridge = getDesktopExtensionsBridge();
      if (!bridge) {
        showToast("Extension activation is available in Shogo Desktop only", 2500);
        return;
      }
      showToast(`Activating ${extension.displayName || extension.name}…`, 1600);
      void bridge.activateEvent(entryPoint.id, gitWorkspaceRootRef.current ?? undefined).then(async (response) => {
        if (!response.ok) {
          showToast(response.error ?? `Extension activation failed: ${extension.id}`, 3500);
          void extensionsSummary.showRunningExtensions();
          return;
        }
        showToast(`Activated ${extension.displayName || extension.name}`, 2200);
        void extensionsSummary.showRunningExtensions();
        void extensionsSummary.loadStatusBarItems();
        const panels = await bridge.getWebviewPanels(gitWorkspaceRootRef.current ?? undefined);
        if (panels.ok) {
          for (const panel of panels.panels ?? []) openExtensionWebviewPanel(panel);
        }
      });
      return;
    }
    showToast(`${entryPoint.label} is not reachable in Shogo yet`, 3000);
  }, [extensionRuntimeContainers, extensionsSummary, openExtensionWebviewPanel, runExtensionCommand, showToast, sidebarOpen]);

  useEffect(() => {
    if (!active?.language || active.rootId === "__extensions__" || PREVIEW_LANGUAGES.has(active.language)) return;
    const bridge = getDesktopExtensionsBridge();
    if (!bridge) return;
    void bridge.activateEvent(`onLanguage:${active.language}`, gitWorkspaceRootRef.current ?? undefined).then(() => {
      void extensionsSummary.showRunningExtensions();
    });
  }, [active?.id, active?.language, active?.rootId, extensionsSummary.showRunningExtensions]);

  // ─── Commands ────────────────────────────────────────────────────────
  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: "file.save", label: "File: Save", shortcut: "⌘S", run: () => void handleSave() },
      { id: "file.saveAll", label: "File: Save All", shortcut: "⌘⌥S", run: () => void handleSaveAll() },
      {
        id: "file.close",
        label: "File: Close Editor",
        shortcut: "⌘W",
        run: () => {
          if (activeGroup?.activeId) closeInGroup(activeGroupIdx, activeGroup.activeId);
        },
      },
      { id: "file.newFile", label: "Explorer: New File", run: () => setNewRequest({ kind: "file", nonce: Date.now() }) },
      { id: "file.newFolder", label: "Explorer: New Folder", run: () => setNewRequest({ kind: "dir", nonce: Date.now() }) },
      { id: "explorer.refresh", label: "Explorer: Refresh All", run: () => void refreshAllRoots() },
      {
        id: "workspace.openFolder",
        label: fsaSupported
          ? "Workspace: Open Folder…"
          : "Workspace: Open Folder… (requires Chrome/Edge)",
        shortcut: "⌘⇧O",
        run: () => void openLocalFolder(),
      },
    ];
    // Add Close Folder for every non-agent root
    for (const r of roots.filter((x) => x.kind === "local")) {
      cmds.push({
        id: `workspace.closeFolder:${r.id}`,
        label: `Workspace: Close Folder "${r.label}"`,
        run: () => void closeRoot(r.id),
      });
    }
    for (const extension of extensionsSummary.installed) {
      if (!extension.enabled || !extension.compatible) continue;
      for (const command of extension.manifest.contributes?.commands ?? []) {
        cmds.push({
          id: `extension:${command.command}`,
          label: `${command.category ? `${command.category}: ` : ""}${command.title}`,
          run: () => runExtensionCommand(command.command),
        });
      }
    }
    for (const container of extensionRuntimeContainers) {
      cmds.push({
        id: `extension.view.${container.activityId}`,
        label: `View: Show ${container.title}`,
        run: () => {
          if (container.location === "panel") {
            ideBottomPanelStore.showExtensionPanelContainer(container.activityId);
            return;
          }
          setActivity(container.activityId);
          if (!sidebarOpen) setSidebarOpen(true);
        },
      });
    }
    cmds.push(
      { id: "view.splitRight", label: "View: Split Editor Right", shortcut: "⌘\\", run: splitRight },
      { id: "view.closeOtherGroup", label: "View: Close Other Editor Group", run: closeOtherGroup },
      { id: "view.focusNextGroup", label: "View: Focus Next Editor Group", shortcut: "⌘K ⌘→", run: focusNextGroup },
      {
        id: "tab.togglePin",
        label: "Tab: Toggle Pin",
        shortcut: "⌘K ⇧Enter",
        run: () => {
          if (activeGroup?.activeId) togglePinInGroup(activeGroupIdx, activeGroup.activeId);
        },
      },
      {
        id: "view.toggleSidebar",
        label: sidebarOpen ? "View: Hide Sidebar" : "View: Show Sidebar",
        shortcut: "⌘B",
        run: () => setSidebarOpen((v) => !v),
      },
      {
        id: "view.toggleBottomPanel",
        label: bottomPanelOpen ? "View: Hide Panel" : "View: Show Panel",
        shortcut: "⌘J",
        run: () => setBottomPanelOpen((v) => !v),
      },
      {
        id: "terminal.new",
        label: "Terminal: New Terminal",
        shortcut: "⌘⇧`",
        run: requestNewTerminal,
      },
      {
        id: "terminal.focus",
        label: "Terminal: Focus Panel",
        shortcut: "⌃`",
        run: () => setBottomPanelOpen(true),
      },
      { id: "goto.file", label: "Go to File…", shortcut: "⌘P", run: () => setPalette("file") },
      {
        id: "search.findInFile",
        label: "Find in File…",
        shortcut: "⌘F",
        run: () => {
          const ed = editorRefs.current[activeGroup?.id ?? ""];
          ed?.getAction("actions.find")?.run();
        },
      },
      {
        id: "search.replaceInFile",
        label: "Replace in File…",
        shortcut: "⌘⌥F",
        run: () => {
          const ed = editorRefs.current[activeGroup?.id ?? ""];
          ed?.getAction("editor.action.startFindReplaceAction")?.run();
        },
      },
      {
        id: "search.findInFiles",
        label: "Search: Find in Files…",
        shortcut: "⌘⇧F",
        run: () => openSearch(),
      },
      {
        id: "view.openSourceControl",
        label: "View: Show Source Control",
        shortcut: "⌃⇧G",
        run: () => {
          setActivity("git");
          if (!sidebarOpen) setSidebarOpen(true);
        },
      },
      { id: "goto.line", label: "Go to Line…", shortcut: "⌃G", run: () => setPalette("line") },
      {
        id: "goto.symbol",
        label: "Go to Symbol in Editor…",
        shortcut: "⌘⇧O",
        run: () => void editorRefs.current[activeGroup?.id ?? ""]?.getAction("editor.action.quickOutline")?.run(),
      },
      { id: "view.zen", label: "View: Toggle Zen Mode", shortcut: "⌘K Z", run: () => setZen((z) => toggleZen(z)) },
      {
        id: "view.toggleWordWrap",
        label: `View: Toggle Word Wrap (${settings.wordWrap === "on" ? "on" : "off"})`,
        run: () => setSettings((s) => ({ ...s, wordWrap: s.wordWrap === "on" ? "off" : "on" })),
      },
      {
        id: "view.toggleMinimap",
        label: "View: Toggle Minimap",
        run: () => setSettings((s) => ({ ...s, minimap: !s.minimap })),
      },
      {
        id: "editor.format",
        label: "Format Document",
        shortcut: "⇧⌥F",
        run: () => void editorRefs.current[activeGroup?.id ?? ""]?.getAction("editor.action.formatDocument")?.run(),
      },
      { id: "editor.changeLanguage", label: "Change Language Mode…", run: () => setPalette("language") },
      {
        id: "file.closeAll",
        label: "File: Close All Editors",
        run: () => {
          if (activeGroup) void closeManyInGroup(activeGroupIdx, activeGroup.files.map((f) => f.id));
        },
      },
      { id: "file.reopenClosed", label: "File: Reopen Closed Editor", shortcut: "⌘⇧T", run: reopenClosed },
      {
        id: "file.revealActive",
        label: "File: Reveal Active File in Explorer",
        run: () => {
          if (active) revealInExplorer(active.path);
        },
      },
      {
        id: "file.copyPath",
        label: "File: Copy Path of Active File",
        run: () => {
          if (active) void copyText(active.path, "path");
        },
      },
      { id: "view.openSettings", label: "Preferences: Open Settings", run: () => { setActivity("settings"); setSidebarOpen(true); } },
      {
        id: "view.reload",
        label: "Developer: Reload Window",
        run: () => window.location.reload(),
      },
      {
        id: "file.nextTab",
        label: "View: Next Editor Tab",
        shortcut: "⌘⌥→",
        run: () => {
          const files = activeGroup?.files ?? [];
          const idx = files.findIndex((f) => f.id === activeGroup?.activeId);
          if (files.length > 1) updateGroup(activeGroupIdx, (gg) => ({ ...gg, activeId: files[(idx + 1) % files.length].id }));
        },
      },
      {
        id: "file.prevTab",
        label: "View: Previous Editor Tab",
        shortcut: "⌘⌥←",
        run: () => {
          const files = activeGroup?.files ?? [];
          const idx = files.findIndex((f) => f.id === activeGroup?.activeId);
          if (files.length > 1) updateGroup(activeGroupIdx, (gg) => ({ ...gg, activeId: files[(idx - 1 + files.length) % files.length].id }));
        },
      },
    );
    return cmds;
  }, [
    handleSave, handleSaveAll, activeGroup, activeGroupIdx, closeInGroup, splitRight,
    closeOtherGroup, focusNextGroup, togglePinInGroup, gotoLine, refreshAllRoots,
    openLocalFolder, closeRoot, fsaSupported, roots, sidebarOpen, bottomPanelOpen,
    requestNewTerminal, extensionsSummary.installed, extensionRuntimeContainers, runExtensionCommand,
    active, settings.wordWrap, closeManyInGroup, reopenClosed, revealInExplorer, copyText, updateGroup,
  ]);

  const commandItems: PaletteItem[] = useMemo(
    () => commands.map((c) => ({ id: c.id, label: c.label, hint: c.shortcut, run: c.run })),
    [commands],
  );

  // Complete path index per root (the tree only holds what has been expanded;
  // ⌘P must find files in folders the user never opened). Refreshed in the
  // background every time Quick Open opens; the cached list shows instantly.
  const [fileIndex, setFileIndex] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (palette !== "file") return;
    let cancelled = false;
    for (const r of roots) {
      const svc = services[r.id];
      if (!svc?.listFiles) continue;
      void svc
        .listFiles()
        .then((files) => {
          if (!cancelled) setFileIndex((prev) => ({ ...prev, [r.id]: files }));
        })
        .catch(() => { /* tree-derived list still works */ });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette === "file"]);

  const fileItems: PaletteItem[] = useMemo(() => {
    // UX-QUICKOPEN-PATH: collapse the sublabel to ONLY the parent-dir
    // hint when it's actually disambiguating (or when multi-root is
    // open and the root label is itself useful context). Full path
    // remains fuzzy-searchable through PaletteItem.searchText, so
    // typing `components/app` still finds App.tsx even when its row
    // shows no visible parent-dir hint.
    const multiRoot = roots.length > 1;
    type Entry = {
      id: string;
      name: string;
      path: string;
      rootLabel: string;
      run: PaletteItem["run"];
      runSide: () => void;
    };
    const entries: Entry[] = [];
    const qoFiles: QuickOpenFile[] = [];
    for (const r of roots) {
      const flat = flattenFiles(r.tree);
      // Paths known to the index but not (yet) in the loaded tree.
      const known = new Set(flat.map((n) => n.path));
      for (const path of fileIndex[r.id] ?? []) {
        if (known.has(path)) continue;
        flat.push({
          kind: "file",
          rootId: r.id,
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
        } as TreeNode);
      }
      for (const n of flat) {
        const id = fileId(n.rootId, n.path);
        entries.push({
          id,
          name: n.name,
          path: n.path,
          rootLabel: r.label,
          run: (o) => {
            if (o?.line) void revealMatch(n.rootId, n.path, o.line, o.col ?? 1);
            else handleOpenFile(n);
          },
          runSide: () => openToSide(n),
        });
        qoFiles.push({
          id,
          name: n.name,
          path: n.path,
          rootLabel: multiRoot ? r.label : undefined,
        });
      }
    }
    const disambig = buildDisambiguation(qoFiles, { multiRoot });
    return entries.map((e) => {
      const d = disambig.get(e.id);
      return {
        id: e.id,
        label: e.name,
        sublabel: d?.display ?? undefined,
        searchText: d?.searchText ?? e.path,
        run: e.run,
        runSide: e.runSide,
      };
    });
  }, [roots, handleOpenFile, fileIndex, revealMatch, openToSide]);

  useEffect(() => {
    if (zen.active) {
      zenPanelRestoreRef.current = ideBottomPanelStore.getState().open;
      if (zenPanelRestoreRef.current) ideBottomPanelStore.setOpen(false);
      try {
        void document.documentElement.requestFullscreen?.().catch(() => {});
      } catch { /* not allowed without a user gesture */ }
    } else if (zenPanelRestoreRef.current !== null) {
      if (zenPanelRestoreRef.current) ideBottomPanelStore.setOpen(true);
      zenPanelRestoreRef.current = null;
      try {
        if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
      } catch { /* ignore */ }
    }
  }, [zen.active]);

  // Problem counts for the status bar (all open models).
  useEffect(() => {
    const m = monacoNsRef.current;
    if (!m) return;
    const recompute = () => {
      let errors = 0;
      let warnings = 0;
      for (const mk of m.editor.getModelMarkers({})) {
        if (mk.severity === 8) errors++;
        else if (mk.severity === 4) warnings++;
      }
      setMarkerCounts((p) => (p.errors === errors && p.warnings === warnings ? p : { errors, warnings }));
    };
    recompute();
    const d = m.editor.onDidChangeMarkers(recompute);
    return () => d.dispose();
  }, [monacoReadyTick]);

  // Selection size / indentation / EOL for the status bar.
  const refreshEditorInfo = useCallback((ed: import("monaco-editor").editor.IStandaloneCodeEditor) => {
    const model = ed.getModel();
    if (!model || model.isDisposed()) return;
    const sel = ed.getSelection();
    let selection: string | null = null;
    if (sel && !sel.isEmpty()) {
      const chars = model.getValueInRange(sel).length;
      const lines = sel.endLineNumber - sel.startLineNumber + 1;
      selection = lines > 1 ? `${chars} selected, ${lines} lines` : `${chars} selected`;
    }
    const o = model.getOptions();
    const indent = `${o.insertSpaces ? "Spaces" : "Tab Size"}: ${o.tabSize}`;
    const eol = model.getEOL() === "\r\n" ? "CRLF" : "LF";
    setEditorInfo((p) => (p.selection === selection && p.indent === indent && p.eol === eol ? p : { selection, indent, eol }));
  }, []);
  const infoAttachedRef = useRef(new WeakSet<object>());
  const attachEditorInfo = useCallback(
    (ed: import("monaco-editor").editor.IStandaloneCodeEditor) => {
      if (infoAttachedRef.current.has(ed)) return;
      infoAttachedRef.current.add(ed);
      ed.onDidChangeCursorSelection(() => refreshEditorInfo(ed));
      ed.onDidChangeModel(() => refreshEditorInfo(ed));
      ed.onDidChangeModelOptions(() => refreshEditorInfo(ed));
      refreshEditorInfo(ed);
    },
    [refreshEditorInfo],
  );

  const toggleEol = useCallback(() => {
    const ed = editorRefs.current[activeGroup?.id ?? ""];
    const m = monacoNsRef.current;
    const model = ed?.getModel();
    if (!ed || !m || !model) return;
    model.pushEOL(
      model.getEOL() === "\r\n" ? m.editor.EndOfLineSequence.LF : m.editor.EndOfLineSequence.CRLF,
    );
    refreshEditorInfo(ed);
  }, [activeGroup, refreshEditorInfo]);

  const zenSettings = useMemo(() => ({ ...settings, lineNumbers: "off" as const }), [settings]);

  // Text carried over when the palette switches mode (`>` in Quick Open).
  const [paletteSeed, setPaletteSeed] = useState("");
  const closePalette = useCallback(() => {
    setPalette(null);
    setPaletteSeed("");
    // Give the editor focus back so typing continues where it left off.
    requestAnimationFrame(() => editorRefs.current[activeGroup?.id ?? ""]?.focus());
  }, [activeGroup]);

  const setActiveFileLanguage = useCallback(
    (language: string) => {
      const id = activeGroup?.activeId;
      if (!id) return;
      setGroups((prev) =>
        prev.map((g) => ({ ...g, files: g.files.map((f) => (f.id === id ? { ...f, language } : f)) })),
      );
    },
    [activeGroup],
  );

  const languageItems: PaletteItem[] = useMemo(() => {
    const langs = monacoNsRef.current?.languages.getLanguages() ?? [];
    return langs
      .map((l) => ({
        id: `lang:${l.id}`,
        label: l.aliases?.[0] ?? l.id,
        sublabel: l.id,
        run: () => setActiveFileLanguage(l.id),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette === "language", setActiveFileLanguage]);

  // ─── Keyboard ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Zen: ⌘K Z toggles, double-Esc leaves. The ⌘K prefix is not swallowed
      // (terminal "clear" etc. keep working); only the completing "z" is.
      {
        const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
        const chord = advanceZenChord(
          zenChordPendingRef.current,
          { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey },
          isMac ? "mac" : "linux",
        );
        zenChordPendingRef.current = chord.pending;
        if (zenChordTimerRef.current) clearTimeout(zenChordTimerRef.current);
        if (chord.pending) {
          zenChordTimerRef.current = setTimeout(() => {
            zenChordPendingRef.current = false;
          }, 1500);
        }
        if (chord.status === "complete") {
          e.preventDefault();
          e.stopPropagation();
          setZen((z) => toggleZen(z));
          return;
        }
        if (e.key === "Escape") {
          const now = Date.now();
          if (shouldExitOnEscape(zen, lastEscapeAtRef.current, now)) {
            setZen((z) => (z.active ? toggleZen(z) : z));
            lastEscapeAtRef.current = null;
          } else {
            lastEscapeAtRef.current = now;
          }
        }
      }
      // Reopen closed editor (⌘⇧T; Ctrl+Shift+T in browsers that reserve ⌘⇧T).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        reopenClosed();
        return;
      }
      // Alt+1…9 jumps to the Nth tab (browsers reserve ⌘/Ctrl+digits).
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const n = parseInt(e.code.slice(5), 10);
        const files = activeGroup?.files ?? [];
        const target = n === 9 ? files[files.length - 1] : files[n - 1];
        if (target) {
          e.preventDefault();
          updateGroup(activeGroupIdx, (gg) => ({ ...gg, activeId: target.id }));
        }
        return;
      }
      // Next / previous tab: ⌘⌥→ / ⌘⌥← and Ctrl+(Shift+)Tab where the host allows it.
      {
        const next =
          ((e.metaKey || e.ctrlKey) && e.altKey && e.key === "ArrowRight") ||
          (e.ctrlKey && !e.shiftKey && e.key === "Tab");
        const prev =
          ((e.metaKey || e.ctrlKey) && e.altKey && e.key === "ArrowLeft") ||
          (e.ctrlKey && e.shiftKey && e.key === "Tab");
        if ((next || prev) && activeGroup && activeGroup.files.length > 1) {
          e.preventDefault();
          const files = activeGroup.files;
          const idx = files.findIndex((f) => f.id === activeGroup.activeId);
          const to = files[(idx + (next ? 1 : -1) + files.length) % files.length];
          updateGroup(activeGroupIdx, (gg) => ({ ...gg, activeId: to.id }));
          return;
        }
      }
      // BUG-005: single dispatcher for both palette shortcuts. Routes
      // through the pure resolvePaletteIntent — "Shift wins → command".
      // stopPropagation prevents any OTHER window-level keydown handler
      // (FileTree, Terminal, future panels) from also firing on Cmd+P.
      const paletteIntent = resolvePaletteIntent(e);
      if (paletteIntent) {
        e.preventDefault();
        e.stopPropagation();
        setPalette(paletteIntent);
        return;
      }
      if (matchesShortcut(e, { meta: true, key: "s" })) {
        e.preventDefault(); void handleSave(); return;
      }
      if (matchesShortcut(e, { meta: true, alt: true, key: "s" })) {
        e.preventDefault(); void handleSaveAll(); return;
      }
      if (matchesShortcut(e, { meta: true, key: "w" })) {
        e.preventDefault();
        if (activeGroup?.activeId) closeInGroup(activeGroupIdx, activeGroup.activeId);
        return;
      }
      if (matchesShortcut(e, { meta: true, key: "\\" })) {
        e.preventDefault(); splitRight(); return;
      }
      // VS Code parity: Ctrl+G = Go to Line (Ctrl on every OS). ⌘G is left
      // alone so Monaco's own "Find Next" keeps working on macOS.
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        e.stopPropagation();
        setPalette("line");
        return;
      }
      // VS Code parity: ⌘⇧O = Go to Symbol in File (Monaco's quick outline).
      // "Open Folder" lives in the Explorer header / command palette.
      if (matchesShortcut(e, { meta: true, shift: true, key: "o" })) {
        e.preventDefault();
        e.stopPropagation();
        const ed = editorRefs.current[activeGroup?.id ?? ""];
        void ed?.getAction("editor.action.quickOutline")?.run();
        return;
      }
      if (matchesShortcut(e, { meta: true, shift: true, key: "f" })) {
        e.preventDefault();
        openSearch();
        return;
      }
      // VS Code parity: ⌃⇧G opens the Source Control activity. Uses Ctrl
      // (not ⌘) on both mac and Windows/Linux to match VS Code's default.
      if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        setActivity("git");
        if (!sidebarOpen) setSidebarOpen(true);
        return;
      }
      if (matchesShortcut(e, { meta: true, key: "b" })) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }
      // VS Code parity: ⌘J (or Ctrl+J on non-mac) toggles the bottom panel.
      // This is the primary shortcut — it survives browser interception much
      // better than the Ctrl+backtick default, which Chrome sometimes eats.
      if (matchesShortcut(e, { meta: true, key: "j" })) {
        e.preventDefault();
        setBottomPanelOpen((v) => !v);
        return;
      }
      // VS Code parity: Ctrl+` as a secondary toggle (power-user muscle memory).
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === "`") {
        e.preventDefault();
        setBottomPanelOpen((v) => !v);
        return;
      }
      // VS Code parity: ⌘⇧` creates a new terminal session (and opens the panel).
      // Match on both the printed key "~" (shift+backtick on US layouts) and the
      // raw key "`" with Shift held, to be layout-tolerant.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === "`" || e.key === "~")
      ) {
        e.preventDefault();
        requestNewTerminal();
        return;
      }
    };
    // Capture phase so shortcuts work while Monaco has focus (bubble listeners never run).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    handleSave, handleSaveAll, activeGroup, activeGroupIdx, closeInGroup, splitRight,
    gotoLine, openLocalFolder, sidebarOpen, requestNewTerminal, zen, reopenClosed, updateGroup,
  ]);

  // --- G1 git wiring ---------------------------------------------------
  // Resolve the absolute workspace root via the desktop fs bridge (managed
  // projects only for G1; external folder-bound projects light up once G2
  // adds an explicit resolver). On non-desktop platforms the bridge is
  // null and `workspaceRoot` stays null, so `useGitStatus` short-circuits
  // and `GitStatusProvider` publishes a noop value — no decorations, no
  // status-bar branch segment, no IPC churn.
  const [gitWorkspaceRoot, setGitWorkspaceRootState] = useState<string | null>(null);
  const setGitWorkspaceRoot = useCallback((v: string | null) => {
    gitWorkspaceRootRef.current = v;
    setGitWorkspaceRootState(v);
  }, []);
  useEffect(() => {
    if (!projectId) {
      setGitWorkspaceRoot(null);
      return;
    }
    if (remoteHostId) {
      // The folder path is meaningful on the SSH host only. Do not hand it
      // to desktop git/IPC, which expects a local absolute path.
      setGitWorkspaceRoot(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // G2: try the git registry FIRST (covers external folder-bound
      // projects via setProjectRoot done in useOpenLocalFolder), fall
      // back to fs.resolveWorkspace (managed projects).
      const gitBridge = getDesktopGitBridge();
      if (gitBridge) {
        const r = await gitBridge.resolveProjectRoot(projectId);
        if (cancelled) return;
        if (r.ok && r.root) {
          setGitWorkspaceRoot(r.root);
          return;
        }
      }
      // A folder-linked project's repo is its folder. Resolve that before
      // the managed-workspace bridge: `workspaces/<id>` can exist for such a
      // project too (older builds seeded a template there), and the git
      // registry above is in-memory, so it is empty after an app restart.
      if (folderPath) {
        setGitWorkspaceRoot(folderPath);
        return;
      }
      const fsBridge = getDesktopFsBridge();
      if (!fsBridge) {
        setGitWorkspaceRoot(null);
        return;
      }
      const r = await fsBridge.resolveWorkspace(projectId, {
        isExternalProject,
        folderPath,
        remoteHostId,
      });
      if (cancelled) return;
      if (r.ok && r.root) {
        setGitWorkspaceRoot(r.root);
        return;
      }
      setGitWorkspaceRoot(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, folderPath, remoteHostId, isExternalProject]);
  const gitSnapshot = useGitStatus(gitWorkspaceRoot);
  const extensionsBridgeAvailable = getDesktopExtensionsBridge() !== null;

  useEffect(() => {
    const bridge = getDesktopExtensionsBridge();
    if (!bridge || !gitWorkspaceRoot) return;
    const documents = groups
      .flatMap((group) => group.files)
      .filter((file) => file.rootId === "agent" && !PREVIEW_LANGUAGES.has(file.language))
      .map((file) => ({
        path: file.path,
        fsPath: workspaceFsPath(gitWorkspaceRoot, file.path),
        languageId: file.language || "plaintext",
        version: documentVersion(file.content, file.dirty),
        text: file.content,
        isDirty: file.dirty,
      }));
    const visibleDocumentPaths = groups
      .map((group) => group.files.find((file) => file.id === group.activeId))
      .filter((file): file is OpenFile => !!file && file.rootId === "agent" && !PREVIEW_LANGUAGES.has(file.language))
      .map((file) => file.path);
    const state: ExtensionWorkspaceState = {
      workspaceRoot: gitWorkspaceRoot,
      workspaceName: roots.find((root) => root.id === "agent")?.label ?? agentLabel,
      activeDocumentPath: active?.rootId === "agent" && !PREVIEW_LANGUAGES.has(active.language) ? active.path : null,
      visibleDocumentPaths,
      documents,
      configuration: {
        editor: settings,
        "editor.fontFamily": settings.fontFamily,
        "editor.fontSize": settings.fontSize,
        "editor.tabSize": settings.tabSize,
        "editor.formatOnSave": settings.formatOnSave,
        "files.autoSave": settings.autoSave ? "afterDelay" : "off",
      },
    };
    void bridge.updateWorkspaceState(state).then((response) => {
      if (!response.ok) console.warn(response.error ?? "Extension workspace state sync failed");
    });
  }, [active?.id, active?.language, active?.path, active?.rootId, agentLabel, gitWorkspaceRoot, groups, roots, settings]);

  // ─── G4: git gutter markers + inline blame + conflict CodeLens ─────
  // Attach Monaco decorations + a code lens provider for the active
  // editor whenever Monaco is ready, a git workspace root is known, and
  // the active file or its git snapshot updates. The integration is a
  // no-op on web/native because `getDesktopGitBridge()` returns null
  // inside `attachGitDecorations`.
  useEffect(() => {
    if (!gitWorkspaceRoot) return;
    if (!active?.path) return;
    const ed = editorRefs.current[activeGroup?.id ?? ""];
    const monaco = monacoNsRef.current;
    if (!ed || !monaco) return;
    const disposer = attachGitDecorations({
      monaco,
      ed,
      workspaceRoot: gitWorkspaceRoot,
      relPath: active.path,
      refreshTick: gitSnapshot?.refreshedAt ?? 0,
    });
    return () => disposer.dispose();
  }, [
    monacoReadyTick,
    gitWorkspaceRoot,
    active?.path,
    activeGroup?.id,
    gitSnapshot?.refreshedAt,
  ]);

  // Activity Bar badges — desktop-only signal so web/mobile keep their
  // intentionally bare rail. `useProblemsBadgeCount` short-circuits
  // when `enabled` is false, so the diagnostics endpoint is never hit
  // outside Electron.
  const desktopBadgesEnabled = isDesktopRuntime();
  const problemsBadgeResult = useProblemsBadgeCount({
    projectId: projectId ?? null,
    enabled: desktopBadgesEnabled,
  });
  const activityBadges: Partial<Record<ActivityId, BadgeData>> | null = useMemo(() => {
    if (!desktopBadgesEnabled) return null;
    const out: Partial<Record<ActivityId, BadgeData>> = {};
    const gitN = gitChangeCount(gitSnapshot);
    if (gitN > 0) out.git = { count: gitN, tone: "neutral" };
    if (extensionsSummary.restartRequired) {
      out.extensions = { count: 1, tone: "warn" };
    } else if (extensionsSummary.installed.length > 0) {
      out.extensions = { count: extensionsSummary.installed.length, tone: "neutral" };
    }
    if (problemsBadgeResult.count > 0) {
      const tone = problemsBadgeResult.severity === "error" ? "error" : "warn";
      // Shogo surfaces the Problems pane under the Files (Explorer)
      // activity (the bottom panel hosts it from Files context), so the
      // problems dot lives on the Files icon — same convention as the
      // BottomPanel toggle.
      out.files = { count: problemsBadgeResult.count, tone };
    }
    return Object.keys(out).length === 0 ? null : out;
  }, [desktopBadgesEnabled, gitSnapshot, problemsBadgeResult.count, problemsBadgeResult.severity, extensionsSummary.restartRequired, extensionsSummary.installed.length, isExternalProject]);

  return (
    <GitStatusProvider snapshot={gitSnapshot}>
    <div
      ref={ideRootRef}
      className="shogo-ide flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden"
      data-theme={themeMode}
    >
      <div className="flex flex-1 min-h-0">
        <div className={`flex flex-1 min-w-0 ${primarySideBarPosition === "left" ? "order-4" : "order-1"}`}>
          <div className="flex flex-1 min-w-0 flex-col">
            <AgentEditBanner
              conflicts={conflicts}
              activeFileId={active?.id ?? null}
              onReload={handleReloadConflict}
              onKeepMine={handleKeepMine}
            />
            <div className="flex flex-1 min-h-0 flex-col">
            <div
              className="flex flex-1 min-h-0 relative"
              style={chrome.centered ? { maxWidth: 1100, margin: "0 auto", width: "100%" } : undefined}
            >
              {graphOpen && projectId && (
                <div className="absolute inset-0 z-30 flex flex-col bg-[color:var(--ide-bg)]">
                  <div className="flex items-center gap-2 px-3 h-9 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-surface)]">
                    <GitBranch size={13} color="var(--ide-muted)" />
                    <span className="text-[12px] text-[color:var(--ide-text-strong)]">Commit Graph</span>
                    <span className="flex-1" />
                    <button
                      onClick={() => setGraphOpen(false)}
                      title="Close graph"
                      className="p-1 rounded hover:bg-[color:var(--ide-hover)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="flex-1 min-h-0">
                    <GraphView projectId={projectId} onOpenFile={openWorkspaceFile} />
                  </div>
                </div>
              )}
              {activity === "checkpoint" && projectId ? (
                // Checkpoint tab: managed projects see a checkpoint-only list;
                // external (open-folder) projects see the full git commit graph.
                <CheckpointListView projectId={projectId} />
              ) : (
              groups
                .map((g, i) => (
                  <div
                    key={g.id}
                    style={{
                      flex:
                        groups.length === 1
                          ? 1
                          : i === 0
                          ? groupSplit.size
                          : 1 - groupSplit.size,
                      minWidth: 0,
                    }}
                    className="flex min-w-0 flex-col"
                  >
                    <EditorGroupView
                      group={g}
                      focused={i === activeGroupIdx}
                      themeMode={themeMode}
                      editorTheme={settings.editorTheme}
                      onFocus={() => setActiveGroupIdx(i)}
                      onSelect={(id) => updateGroup(i, (gg) => ({ ...gg, activeId: id }))}
                      onClose={(id) => closeInGroup(i, id)}
                      onTogglePin={(id) => togglePinInGroup(i, id)}
                      onReorder={(ids) => reorderInGroup(i, ids)}
                      onChange={handleChangeFor(i)}
                      onRetryOpen={(id) => retryOpen(i, id)}
                      onRevealPath={revealInExplorer}
                      gitRefreshKey={gitSnapshot?.refreshedAt}
                      onOpenPlainFile={openWorkspaceFile}
                      onCloseMany={(ids) => void closeManyInGroup(i, ids)}
                      onCopyText={(t, what) => void copyText(t, what)}
                      onRevealFile={(id) => {
                        const f = g.files.find((x) => x.id === id);
                        if (f) revealInExplorer(f.path);
                      }}
                      onNewFile={() => {
                        setActivity("files");
                        setSidebarOpen(true);
                        setNewRequest({ kind: "file", nonce: Date.now() });
                      }}
                      onCursor={(line, col) => setCursor({ line, col })}
                      settings={chrome.lineNumbers ? settings : zenSettings}
                      hideTabs={!chrome.tabs}
                      installedExtensions={extensionsSummary.installed}
                      extensionInstallingId={extensionsSummary.installingId}
                      onInstallExtension={requestExtensionInstall}
                      onEnableExtension={(id) => void extensionsSummary.setEnabled(id, true)}
                      onDisableExtension={(id) => void extensionsSummary.setEnabled(id, false)}
                      onUninstallExtension={(id) => void extensionsSummary.uninstall(id)}
                      onRunExtensionCommand={runExtensionCommand}
                      onUseExtensionEntryPoint={useExtensionEntryPoint}
                      onSetMdMode={handleSetMdMode}
                      onEditorMount={(ed, monaco) => {
                        editorRefs.current[g.id] = ed;
                        attachEditorInfo(ed);
                        if (monaco && monacoNsRef.current !== monaco) {
                          monacoNsRef.current = monaco;
                          setMonacoReadyTick((t) => t + 1);
                        }
                      }}
                    />
                  </div>
                ))
                .reduce<React.ReactNode[]>((acc, el, i) => {
                  acc.push(el);
                  if (i === 0 && groups.length > 1) {
                    acc.push(
                      <VerticalSplit
                        key={`split-${i}`}
                        onMouseDown={(e) => {
                          const totalW = (e.currentTarget.parentElement?.clientWidth ?? 1000) - 4;
                          const startX = e.clientX;
                          const startSize = groupSplit.size;
                          const move = (ev: MouseEvent) => {
                            const delta = (ev.clientX - startX) / totalW;
                            const next = Math.min(0.8, Math.max(0.2, startSize + delta));
                            groupSplit.setSize(next);
                          };
                          const up = () => {
                            window.removeEventListener("mousemove", move);
                            window.removeEventListener("mouseup", up);
                            document.body.style.cursor = "";
                            document.body.style.userSelect = "";
                          };
                          window.addEventListener("mousemove", move);
                          window.addEventListener("mouseup", up);
                          document.body.style.cursor = "col-resize";
                          document.body.style.userSelect = "none";
                          e.preventDefault();
                        }}
                      />,
                    );
                  }
                  return acc;
                }, [])
              )}

              {confirmReq && (
                <ConfirmDialog
                  title={confirmReq.title}
                  message={confirmReq.message}
                  buttons={confirmReq.buttons}
                  cancelValue={confirmReq.cancelValue}
                  onResolve={resolveConfirm}
                />
              )}
              {toast && (
                <div className="pointer-events-none absolute bottom-4 right-4 z-40 rounded bg-[color:var(--ide-primary)] px-3 py-1.5 text-[12px] text-white shadow-lg">
                  {toast}
                </div>
              )}
              {extensionUiRequest && (
                <ExtensionUiRequestDialog
                  request={extensionUiRequest}
                  onResolve={(result) => respondToExtensionUiRequest(extensionUiRequest.requestId, result, true)}
                  onCancel={() => respondToExtensionUiRequest(extensionUiRequest.requestId, undefined, true)}
                />
              )}
            </div>

            {/*
              * The bottom drawer (Terminal / Problems / Output) is mounted
              * by `DrawerHost` at the project layout level so it survives
              * previewTab changes (Canvas → IDE → Files cycles no longer
              * drop the user's terminal sessions). The Workbench keeps the
              * ⌘J / ⌘⇧` keybinds and command palette items but defers the
              * actual mount + size + peek-handle to the lifted host.
              */}
            </div>

          </div>
        </div>

        {/* The Checkpoint activity renders the commit graph as a full
            main-area view (graph columns + a 400px detail panel), so it
            suppresses the narrow sidebar — otherwise the detail panel
            overflows and squeezes the graph to nothing. */}
        {sidebarOpen && chrome.sideBar && activity !== "checkpoint" && (
          <>

            <VerticalSplit
              onMouseDown={sidebarSplit.onMouseDown}
              className={primarySideBarPosition === "left" ? "order-3" : "order-2"}
            />

            <div
              style={{ width: sidebarSplit.size, flexShrink: 0, maxWidth: "55%", minWidth: 0 }}
              className={`h-full bg-[color:var(--ide-surface)] overflow-hidden ${primarySideBarPosition === "left" ? "order-2" : "order-3"}`}
            >
              {activity === "files" && (
                <FilesPane
                  roots={roots}
                  virtualTree={virtualTree}
                  activePath={active?.path ?? null}
                  handlers={treeHandlers}
                  newRequest={newRequest}
                  revealRequest={revealReq}
                  fsaSupported={fsaSupported}
                  onRefresh={refreshAllRoots}
                  onNew={(kind) => setNewRequest({ kind, nonce: Date.now() })}
                  onOpenFolder={() => void openLocalFolder()}
                  onRestore={() => void restoreRoots()}
                  onCloseRoot={(id) => void closeRoot(id)}
                  onCollapse={() => setSidebarOpen(false)}
                />
              )}
              {activity === "search" && (
                <SearchPane
                  roots={roots}
                  services={services}
                  seed={searchSeed}
                  persisted={searchPersistRef.current}
                  onPersist={persistSearch}
                  onReveal={(rootId, path, line, col) =>
                    void revealMatch(rootId, path, line, col)
                  }
                  onReplaced={(matches, files) => {
                    showToast(
                      `Replaced ${matches} match${matches === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}`,
                    );
                  }}
                />
              )}
              {activity === "git" && (
                <div className="flex flex-col h-full">
                  <div className="flex-1 min-h-0">
                <SourceControlViewlet
                  workspaceRoot={gitWorkspaceRoot}
                  onOpenFile={openWorkspaceFile}
                  onOpenDiff={(path, group) => {
                    if (group === "merge" && gitWorkspaceRoot) {
                      // Merge conflicts open the 3-way merge editor
                      setMergePath(path);
                    } else if (gitWorkspaceRoot && getDesktopGitBridge()) {
                      // Staged/changes: real diff tab (HEAD ↔ index ↔ working tree)
                      openGitDiffTab(path, group === "staged" ? "staged" : "changes", gitWorkspaceRoot);
                    } else {
                      openWorkspaceFile(path);
                    }
                  }}
                  // Checkpoint now lives on its own activity bar entry
                  // (id: "checkpoint"); the SourceControl viewlet no
                  // longer falls back to it. If the project has no git
                  // repo, the viewlet renders its own empty state.
                />
                  </div>
                </div>
              )}
              {activity === "debug" && (
                <RunDebugPanel workspaceRoot={gitWorkspaceRoot} />
              )}
              {activity === "extensions" && (
                <ExtensionsViewlet workspaceRoot={gitWorkspaceRoot} onOpenDetails={openExtensionDetailsTab} onUseEntryPoint={useExtensionEntryPoint} />
              )}
              {activeExtensionRuntimeContainer && (
                <ExtensionRuntimeViewlet
                  container={activeExtensionRuntimeContainer}
                  onRunCommand={runExtensionCommand}
                  onOpenDetails={openExtensionDetailsTab}
                  onLoadView={loadExtensionRuntimeView}
                />
              )}
              {activity === "settings" && (
                <SettingsPane settings={settings} onChange={setSettings} />
              )}
            </div>
          </>
          )}

        {chrome.activityBar && (
        <ActivityBar
          className={primarySideBarPosition === "left" ? "order-1" : "order-4"}
          active={activity}
          sidebarOpen={sidebarOpen}
          terminalOpen={bottomPanelOpen}
          badges={activityBadges}
          hiddenItemIds={[
            ...(extensionsBridgeAvailable ? [] : (["extensions"] as ActivityId[])),
            // Run & Debug is an Electron-only surface; don't advertise a dead end on web.
            ...(isDesktopRuntime() ? [] : (["debug"] as ActivityId[])),
          ]}
          extensionContainers={activityBarExtensionContainers}
          onSelect={(id) => {
            setActivity(id);
            if (!sidebarOpen) setSidebarOpen(true);
          }}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onToggleTerminal={() => setBottomPanelOpen((v) => !v)}
        />
        )}
      </div>

      {chrome.statusBar && (
      <StatusBar
        language={active?.language ?? "—"}
        line={cursor.line}
        col={cursor.col}
        selection={editorInfo.selection}
        indent={editorInfo.indent}
        eol={editorInfo.eol}
        problems={markerCounts}
        onGoToLine={() => setPalette("line")}
        onPickLanguage={() => setPalette("language")}
        onToggleEol={toggleEol}
        onShowProblems={() => {
          ideBottomPanelStore.setActiveTab("Problems");
          ideBottomPanelStore.setOpen(true);
        }}
        saved={!active?.dirty}
        git={gitSnapshot}
        workspaceRoot={gitWorkspaceRoot}
        extensionItems={extensionsSummary.statusBarItems}
        onRunExtensionCommand={runExtensionCommand}
      />
      )}


      {pendingExtensionInstall && (
        <div className="absolute inset-0 z-50">
          <TrustPublisherDialog
            extension={pendingExtensionInstall}
            onCancel={() => setPendingExtensionInstall(null)}
            onTrust={trustAndInstallExtension}
          />
        </div>
      )}

      {palette === "command" && (
        <Palette
          placeholder="Type a command…"
          items={commandItems}
          onClose={closePalette}
          initialQuery={paletteSeed}
          emptyHint="No commands match"
        />
      )}
      {palette === "file" && (
        <QuickOpen
          fileItems={fileItems}
          onClose={closePalette}
          onLine={gotoLine}
          onPrefix={(prefix, rest) => {
            if (prefix === ">") {
              setPaletteSeed(rest);
              setPalette("command");
              return true;
            }
            // `@` → Go to Symbol in File (Monaco's own quick outline).
            closePalette();
            window.setTimeout(() => {
              void editorRefs.current[activeGroup?.id ?? ""]?.getAction("editor.action.quickOutline")?.run();
            }, 60);
            return true;
          }}
        />
      )}
      {palette === "line" && (
        <QuickOpen lineOnly fileItems={[]} onClose={closePalette} onLine={gotoLine} />
      )}
      {palette === "language" && (
        <Palette
          placeholder="Select language mode"
          items={languageItems}
          onClose={closePalette}
          emptyHint="No languages match"
        />
      )}
      {mergePath && gitWorkspaceRoot && monacoNsRef.current && (
        <MergeEditorModal
          monaco={monacoNsRef.current}
          workspaceRoot={gitWorkspaceRoot}
          relPath={mergePath}
          onClose={() => setMergePath(null)}
          onSave={async (content) => {
            // Reuse the existing single-file save path so the dirty bit,
            // savedContent, and toast all behave normally.
            const f = groupsRef.current
              .flatMap((g) => g.files)
              .find((x) => x.path === mergePath);
            if (!f) return;
            const svc = svcOf(f.rootId);
            if (!svc) return;
            await svc.writeFile(f.path, content);
            setGroups((prev) =>
              prev.map((g) => ({
                ...g,
                files: g.files.map((x) =>
                  x.id === f.id ? { ...x, content, savedContent: content, dirty: false } : x,
                ),
              })),
            );
          }}
        />
      )}
    </div>
    </GitStatusProvider>
  );
}

function QuickOpen({
  fileItems,
  onClose,
  onLine,
  onPrefix,
  lineOnly = false,
}: {
  onPrefix?: (prefix: string, rest: string) => boolean;
  fileItems: PaletteItem[];
  onClose: () => void;
  onLine: (line: number) => void;
  /** Ctrl+G mode: bare numbers are line numbers, no file list. */
  lineOnly?: boolean;
}) {
  return (
    <Palette
      placeholder={
        lineOnly
          ? "Go to line…   (type a line number)"
          : "Go to file…   (name:42 opens at a line · > commands · @ symbols · ⌘↵ opens to the side)"
      }
      items={fileItems}
      onClose={onClose}
      onPrefix={lineOnly ? undefined : onPrefix}
      parseLineSuffix={!lineOnly}
      emptyHint={
        lineOnly
          ? "Type a line number"
          : "No files match. Tips: name:42 opens at a line, > runs commands, @ jumps to a symbol."
      }
      syntheticItem={(q) => {
        const m = q.match(lineOnly ? /^:?(\d+)$/ : /^:(\d+)$/);
        if (!m) return null;
        const line = parseInt(m[1], 10);
        return {
          id: `__line__${line}`,
          label: `Go to line ${line}`,
          sublabel: "in current editor",
          run: () => onLine(line),
        };
      }}
    />
  );
}

function FilesPane({
  roots,
  virtualTree,
  activePath,
  handlers,
  newRequest,
  revealRequest,
  fsaSupported,
  onRefresh,
  onNew,
  onOpenFolder,
  onRestore,
  onCloseRoot,
  onCollapse,
}: {
  roots: Root[];
  virtualTree: TreeNode[];
  activePath: string | null;
  handlers: FileTreeHandlers;
  newRequest: { kind: "file" | "dir"; nonce: number; rootId?: string } | null;
  revealRequest?: { path: string; nonce: number } | null;
  fsaSupported: boolean;
  onRefresh: () => void;
  onNew: (kind: "file" | "dir") => void;
  onOpenFolder: () => void;
  onRestore: () => void;
  onCloseRoot: (id: string) => void;
  onCollapse?: () => void;
}) {
  const [collapseReq, setCollapseReq] = useState<{ nonce: number } | null>(null);
  const anyLoading = roots.some((r) => r.loading);
  const anyError = roots.find((r) => r.error);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
          Explorer
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onOpenFolder}
            title={fsaSupported ? "Add local folder…" : "Local folders require Chrome or Edge"}
            disabled={!fsaSupported}
            className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FolderOpen size={13} />
          </button>
          {fsaSupported && (
            <button
              onClick={onRestore}
              title="Reopen recent local folder"
              className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
            >
              <History size={13} />
            </button>
          )}
          <button
            onClick={() => onNew("file")}
            title="New File"
            className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
          >
            <FilePlus size={13} />
          </button>
          <button
            onClick={() => onNew("dir")}
            title="New Folder"
            className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
          >
            <FolderPlus size={13} />
          </button>
          <button
            onClick={() => setCollapseReq({ nonce: Date.now() })}
            title="Collapse Folders in Explorer"
            className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
          >
            <ChevronsDownUp size={13} />
          </button>
          <button
            onClick={onRefresh}
            title="Refresh All"
            className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
          >
            <RefreshCw size={13} />
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              title="Hide Sidebar  (⌘B)"
              className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-white"
            >
              <PanelLeftClose size={13} />
            </button>
          )}
        </div>
      </div>


      {anyError ? (
        <div className="px-4 py-3 text-[12px] text-[color:var(--ide-error)]">
          <div className="flex items-center gap-1 mb-1">
            <AlertTriangle size={13} /> {anyError.label}
          </div>
          <div className="text-[color:var(--ide-muted)]">{anyError.error}</div>
        </div>
      ) : null}

      <div className="flex-1 overflow-auto">
        <FileTree
          tree={virtualTree}
          activePath={activePath}
          handlers={handlers}
          newRequest={newRequest}
          revealRequest={revealRequest}
          collapseRequest={collapseReq}
        />
      </div>

      {/* Local root badges at the bottom for quick close */}
      {roots.filter((r) => r.kind === "local").length > 0 && (
        <div className="border-t border-[color:var(--ide-border)] px-3 py-2">
          {roots
            .filter((r) => r.kind === "local")
            .map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-2 rounded px-1 py-[2px] text-[11px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]"
              >
                <span className="flex min-w-0 items-center gap-1.5 truncate"><Folder size={12} />{r.label}</span>
                <button
                  onClick={() => onCloseRoot(r.id)}
                  className="rounded p-[2px] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
                  title="Close folder"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function ExtensionUiRequestDialog({
  request,
  onResolve,
  onCancel,
}: {
  request: ExtensionUiRequest;
  onResolve: (result: unknown) => void;
  onCancel: () => void;
}) {
  const [inputValue, setInputValue] = useState(() => String((request.payload.options as { value?: unknown } | undefined)?.value ?? ""));
  const message = String(request.payload.message ?? (request.payload.options as { prompt?: unknown; placeHolder?: unknown } | undefined)?.prompt ?? "Extension request");
  const items = Array.isArray(request.payload.items) ? request.payload.items : [];
  const title = request.kind === "quickPick" ? "Select an option" : request.kind === "inputBox" ? "Extension input" : "Extension notification";
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-[color:var(--ide-border)] bg-[color:var(--ide-panel)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[color:var(--ide-border)] px-4 py-2">
          <div>
            <div className="text-[12px] font-semibold text-[color:var(--ide-text-strong)]">{title}</div>
            <div className="text-[10px] text-[color:var(--ide-muted)]">{request.extensionId}</div>
          </div>
          <button onClick={onCancel} className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text)]" aria-label="Dismiss extension request">
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div className="text-[12px] text-[color:var(--ide-text)]">{message}</div>
          {request.kind === "quickPick" && (
            <div className="max-h-72 overflow-auto rounded border border-[color:var(--ide-border)]">
              {items.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-[color:var(--ide-muted)]">No quick pick items were provided.</div>
              ) : items.map((item, index) => {
                const label = quickPickLabel(item, index);
                const detail = quickPickDetail(item);
                return (
                  <button key={`${label}:${index}`} onClick={() => onResolve(item)} className="block w-full border-b border-[color:var(--ide-border)] px-3 py-2 text-left last:border-b-0 hover:bg-[color:var(--ide-hover)]">
                    <div className="text-[12px] text-[color:var(--ide-text-strong)]">{label}</div>
                    {detail && <div className="text-[10px] text-[color:var(--ide-muted)]">{detail}</div>}
                  </button>
                );
              })}
            </div>
          )}
          {request.kind === "inputBox" && (
            <form onSubmit={(event) => { event.preventDefault(); onResolve(inputValue); }} className="space-y-3">
              <input
                autoFocus
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                placeholder={String((request.payload.options as { placeHolder?: unknown } | undefined)?.placeHolder ?? "")}
                className="w-full rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-bg)] px-3 py-2 text-[12px] text-[color:var(--ide-text)] outline-none focus:border-[color:var(--ide-primary)]"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-[11px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">Cancel</button>
                <button type="submit" className="rounded bg-[color:var(--ide-primary)] px-3 py-1.5 text-[11px] text-white">OK</button>
              </div>
            </form>
          )}
          {request.kind === "notification" && (
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={onCancel} className="rounded px-3 py-1.5 text-[11px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">Dismiss</button>
              {items.map((item, index) => (
                <button key={`${quickPickLabel(item, index)}:${index}`} onClick={() => onResolve(item)} className="rounded bg-[color:var(--ide-primary)] px-3 py-1.5 text-[11px] text-white">
                  {quickPickLabel(item, index)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function quickPickLabel(item: unknown, index: number): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object" && "label" in item && typeof (item as { label?: unknown }).label === "string") return (item as { label: string }).label;
  return `Item ${index + 1}`;
}

function quickPickDetail(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const record = item as { description?: unknown; detail?: unknown };
  return typeof record.detail === "string" ? record.detail : typeof record.description === "string" ? record.description : null;
}

function Placeholder({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
        {title}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-[color:var(--ide-muted)]">
        <div className="text-[color:var(--ide-primary)]">{icon}</div>
        <div className="text-[13px]">{hint}</div>
      </div>
    </div>
  );
}
