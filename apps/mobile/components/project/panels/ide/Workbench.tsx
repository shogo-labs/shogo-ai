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
import { attachGitDecorations, maybeAutoStageIfConflictResolved } from "./git/editorIntegration";
import { MergeEditorModal } from "./git/MergeEditorModal";
import { getDesktopGitBridge } from "./git/bridge";
import { getDesktopFsBridge } from "./workspace/desktopFs";
import { EditorGroupView } from "./EditorGroup";
import { applyEditorChange } from "./editor-change-apply";
import { isImagePath } from "./ImagePreview";
import {
  isAudioPath,
  isFontPath,
  isPdfPath,
  isVideoPath,
} from "./MediaPreview";
import { Palette, type PaletteItem } from "./Palette";
import {
  ideBottomPanelStore,
  useBottomPanelState,
} from "../../../../lib/ide-bottom-panel-store";
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
import { SearchPane } from "./SearchPane";
import { SettingsPane } from "./SettingsPane";
import { CheckpointsPanel } from "../CheckpointsPanel";
import { useLiveAgentEdits, type LiveConflict } from "./useLiveAgentEdits";
import { AgentEditBanner } from "./AgentEditBanner";
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
import { useTheme } from "../../../../contexts/theme";
import { isBinaryFilePath } from "@shogo-ai/sdk/file-types";
import {
  RefreshCw,
  History,
  AlertTriangle,
  FilePlus,
  FolderPlus,
  FolderOpen,
  PanelLeftClose,
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
}) {
  const themeMode = useResolvedTheme();
  const [activity, setActivity] = useState<ActivityId>("files");
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
  const [newRequest, setNewRequest] = useState<
    { kind: "file" | "dir"; nonce: number; rootId?: string } | null
  >(null);
  const [palette, setPalette] = useState<"command" | "file" | null>(null);

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

  const sidebarSplit = useResizable({ initial: 280, min: 200, max: 540, direction: "horizontal" });
  const groupSplit = useResizable({ initial: 0.5, min: 0.2, max: 0.8, direction: "horizontal" });

  const editorRefs = useRef<Record<string, editor.IStandaloneCodeEditor>>({});
  const monacoNsRef = useRef<MonacoNs | null>(null);
  // Bumped each time a Monaco editor mounts so the backend-LSP wiring effect
  // below can run as soon as `monaco` is first available (effects can't read
  // refs reactively).
  const [monacoReadyTick, setMonacoReadyTick] = useState(0);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
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

  const loadRoot = useCallback(
    async (id: string) => {
      const svc = services[id];
      if (!svc) return;
      setRoot(id, { loading: true, error: null });
      try {
        const raw = await svc.listTree("", 4);
        setRoot(id, { tree: annotateRoot(raw, id), loading: false });
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


  // BUG-001 fix: route the change by the explicit `fileId` carried out of
  // CodeEditor (which derived it from the live Monaco model URI), NOT by
  // the group's currently-tracked `activeId`. The old code matched on
  // `f.id === g.activeId`, which on a rapid tab swap could land the
  // previous tab's last keystroke in the newly-active tab (because React
  // had already advanced `activeId` while Monaco was still firing for the
  // outgoing model). `applyEditorChange` is the pure resolver — it ignores
  // activeId entirely, drops no-op flushes, and treats a missing fileId
  // (closed mid-flight) as a no-op without re-rendering.
  const handleChangeFor = (groupIdx: number) => (fileId: string, val: string) => {
    updateGroup(groupIdx, (g) => applyEditorChange(g, fileId, val));
  };

  const closeInGroup = useCallback((groupIdx: number, id: string) => {
    // Closing a conflicted tab discards the banner for that file.
    setConflicts((cs) => cs.filter((c) => c.fileId !== id));
    setGroups((prev) => {
      const g = prev[groupIdx];
      if (!g) return prev;
      const idx = g.files.findIndex((f) => f.id === id);
      if (idx < 0) return prev;
      const f = g.files[idx];
      if (f.dirty && !confirm(`Close ${f.name} without saving?`)) return prev;
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
      } catch (err) {
        showToast(`Create failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      }
    },
    [svcOf, loadRoot, showToast],
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
            return { ...f, id: fileId(rootId, to), path: to, name: to.split("/").pop() ?? to };
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
    [svcOf, loadRoot, showToast],
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

  const treeHandlers: FileTreeHandlers = useMemo(
    () => ({
      onOpen: handleOpenFile,
      onCreate: handleCreate,
      onRename: handleRenameNode,
      onDelete: handleDeleteNode,
      onMove: handleMove,
      onLoadSubtree: loadSubtree,
    }),
    [handleOpenFile, handleCreate, handleRenameNode, handleDeleteNode, handleMove, loadSubtree],
  );

  // ─── Save ────────────────────────────────────────────────────────────
  const persistOpenFile = useCallback(
    async (f: OpenFile, silent?: boolean): Promise<boolean> => {
      const svc = svcOf(f.rootId);
      if (!svc) return false;
      const content = f.content;
      const id = f.id;
      try {
        await svc.writeFile(f.path, content);
        let applied = false;
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            files: g.files.map((x) => {
              if (x.id !== id) return x;
              if (x.content !== content) return x;
              applied = true;
              return { ...x, dirty: false, savedContent: content };
            }),
          })),
        );
        if (applied) setConflicts((cs) => cs.filter((c) => c.fileId !== id));
        // G4.5 auto-stage: if this file was a merge conflict and the user
        // saved a buffer with no conflict markers left, treat it as
        // resolved and `git add` it. No-op on web/native (bridge null).
        const root = gitWorkspaceRootRef.current;
        if (root) {
          void maybeAutoStageIfConflictResolved(root, f.path, content);
        }
        if (!silent) showToast(`Saved ${f.name}`);
        return true;
      } catch (err) {
        showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
        return false;
      }
    },
    [svcOf, showToast],
  );

  const handleSave = useCallback(async () => {
    if (!active || !active.dirty) return;
    await persistOpenFile(active);
  }, [active, persistOpenFile]);

  const handleSaveAll = useCallback(async () => {
    const dirty = groups.flatMap((g) => g.files.filter((f) => f.dirty));
    if (!dirty.length) {
      showToast("Nothing to save");
      return;
    }
    const results = await Promise.all(dirty.map((f) => persistOpenFile(f, true)));
    if (results.every(Boolean)) {
      showToast(`Saved ${dirty.length} file${dirty.length === 1 ? "" : "s"}`);
    }
  }, [groups, persistOpenFile, showToast]);

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
    }, AUTO_SAVE_DELAY_MS);
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [active, active?.content, active?.dirty, settings.autoSave, persistOpenFile]);

  // ─── Splits ──────────────────────────────────────────────────────────
  const splitRight = useCallback(() => {
    if (groups.length >= 2) {
      showToast("Already split (max 2 groups in Phase 4)", 2000);
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
        run: () => setActivity("search"),
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
      {
        id: "goto.line",
        label: "Go to Line…",
        shortcut: "⌘G",
        run: () => {
          const input = prompt("Go to line:");
          const n = input && parseInt(input, 10);
          if (n && n > 0) gotoLine(n);
        },
      },
    );
    return cmds;
  }, [
    handleSave, handleSaveAll, activeGroup, activeGroupIdx, closeInGroup, splitRight,
    closeOtherGroup, focusNextGroup, togglePinInGroup, gotoLine, refreshAllRoots,
    openLocalFolder, closeRoot, fsaSupported, roots, sidebarOpen, bottomPanelOpen,
    requestNewTerminal,
  ]);

  const commandItems: PaletteItem[] = useMemo(
    () => commands.map((c) => ({ id: c.id, label: c.label, hint: c.shortcut, run: c.run })),
    [commands],
  );

  const fileItems: PaletteItem[] = useMemo(() => {
    const all: PaletteItem[] = [];
    for (const r of roots) {
      const flat = flattenFiles(r.tree);
      for (const n of flat) {
        all.push({
          id: fileId(n.rootId, n.path),
          label: n.name,
          sublabel: roots.length > 1 ? `${r.label} / ${n.path}` : n.path,
          run: () => handleOpenFile(n),
        });
      }
    }
    return all;
  }, [roots, handleOpenFile]);

  // ─── Keyboard ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, { meta: true, shift: true, key: "p" })) {
        e.preventDefault(); setPalette("command"); return;
      }
      if (matchesShortcut(e, { meta: true, key: "p" })) {
        e.preventDefault(); setPalette("file"); return;
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
      if (matchesShortcut(e, { meta: true, key: "g" })) {
        e.preventDefault();
        const input = prompt("Go to line:");
        const n = input && parseInt(input, 10);
        if (n && n > 0) gotoLine(n);
        return;
      }
      if (matchesShortcut(e, { meta: true, shift: true, key: "o" })) {
        e.preventDefault(); void openLocalFolder(); return;
      }
      if (matchesShortcut(e, { meta: true, shift: true, key: "f" })) {
        e.preventDefault();
        setActivity("search");
        if (!sidebarOpen) setSidebarOpen(true);
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
    gotoLine, openLocalFolder, sidebarOpen, requestNewTerminal,
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
      const fsBridge = getDesktopFsBridge();
      if (!fsBridge) {
        setGitWorkspaceRoot(null);
        return;
      }
      const r = await fsBridge.resolveWorkspace(projectId);
      if (cancelled) return;
      setGitWorkspaceRoot(r.ok && r.root ? r.root : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const gitSnapshot = useGitStatus(gitWorkspaceRoot);

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
    if (problemsBadgeResult.count > 0) {
      const tone = problemsBadgeResult.severity === "error" ? "error" : "warn";
      // Shogo surfaces the Problems pane under the Files (Explorer)
      // activity (the bottom panel hosts it from Files context), so the
      // problems dot lives on the Files icon — same convention as the
      // BottomPanel toggle.
      out.files = { count: problemsBadgeResult.count, tone };
    }
    return Object.keys(out).length === 0 ? null : out;
  }, [desktopBadgesEnabled, gitSnapshot, problemsBadgeResult.count, problemsBadgeResult.severity]);

  return (
    <GitStatusProvider snapshot={gitSnapshot}>
    <div
      className="shogo-ide flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden"
      data-theme={themeMode}
    >
      <div className="flex flex-1 min-h-0">
        <ActivityBar
          active={activity}
          sidebarOpen={sidebarOpen}
          terminalOpen={bottomPanelOpen}
          badges={activityBadges}
          onSelect={(id) => {
            setActivity(id);
            if (!sidebarOpen) setSidebarOpen(true);
          }}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onToggleTerminal={() => setBottomPanelOpen((v) => !v)}
        />

        <div className="flex flex-1 min-w-0">
          {sidebarOpen && (
            <>
              <div
                style={{ width: sidebarSplit.size, flexShrink: 0, maxWidth: "55%", minWidth: 0 }}
                className="h-full bg-[color:var(--ide-surface)] overflow-hidden"
              >
                {activity === "files" && (
                  <FilesPane
                    roots={roots}
                    virtualTree={virtualTree}
                    activePath={active?.path ?? null}
                    handlers={treeHandlers}
                    newRequest={newRequest}
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
                  <SourceControlViewlet
                    workspaceRoot={gitWorkspaceRoot}
                    onOpenDiff={(path, group) => {
                      // G4.5: clicking a Merge row opens the 3-way merge
                      // editor. Other groups still fall through to the
                      // (forthcoming) Monaco diff view — tracked as G2.5
                      // polish.
                      if (group === "merge" && gitWorkspaceRoot) {
                        setMergePath(path);
                      }
                    }}
                    // Checkpoint now lives on its own activity bar entry
                    // (id: "checkpoint"); the SourceControl viewlet no
                    // longer falls back to it. If the project has no git
                    // repo, the viewlet renders its own empty state.
                  />
                )}
                {activity === "checkpoint" && projectId && (
                  <CheckpointsPanel visible projectId={projectId} />
                )}
                {activity === "debug" && (
                  <RunDebugPanel workspaceRoot={gitWorkspaceRoot} />
                )}
                {activity === "settings" && (
                  <SettingsPane settings={settings} onChange={setSettings} />
                )}
              </div>

              <VerticalSplit onMouseDown={sidebarSplit.onMouseDown} />
            </>
          )}

          <div className="flex flex-1 min-w-0 flex-col">
            <AgentEditBanner
              conflicts={conflicts}
              activeFileId={active?.id ?? null}
              onReload={handleReloadConflict}
              onKeepMine={handleKeepMine}
            />
            <div className="flex flex-1 min-h-0 flex-col">
            <div className="flex flex-1 min-h-0 relative">
              {groups
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
                      onCursor={(line, col) => setCursor({ line, col })}
                      settings={settings}
                      onEditorMount={(ed, monaco) => {
                        editorRefs.current[g.id] = ed;
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
                }, [])}

              {toast && (
                <div className="pointer-events-none absolute bottom-4 right-4 z-40 rounded bg-[color:var(--ide-primary)] px-3 py-1.5 text-[12px] text-white shadow-lg">
                  {toast}
                </div>
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
      </div>

      <StatusBar
        language={active?.language ?? "—"}
        line={cursor.line}
        col={cursor.col}
        saved={!active?.dirty}
        git={gitSnapshot}
        workspaceRoot={gitWorkspaceRoot}
      />

      {palette === "command" && (
        <Palette
          placeholder="Type a command…"
          items={commandItems}
          onClose={() => setPalette(null)}
          emptyHint="No commands match"
        />
      )}
      {palette === "file" && (
        <QuickOpen fileItems={fileItems} onClose={() => setPalette(null)} onLine={gotoLine} />
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
}: {
  fileItems: PaletteItem[];
  onClose: () => void;
  onLine: (line: number) => void;
}) {
  return (
    <Palette
      placeholder="Go to file…   (type :N to jump to line N in the current editor)"
      items={fileItems}
      onClose={onClose}
      emptyHint="No files match. Tip: type :42 to jump to line 42."
      syntheticItem={(q) => {
        const m = q.match(/^:(\d+)$/);
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
  fsaSupported: boolean;
  onRefresh: () => void;
  onNew: (kind: "file" | "dir") => void;
  onOpenFolder: () => void;
  onRestore: () => void;
  onCloseRoot: (id: string) => void;
  onCollapse?: () => void;
}) {
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
            onClick={onRefresh}
            title="Refresh All"
            className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
          >
            <RefreshCw size={13} className={anyLoading ? "animate-spin" : ""} />
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              title="Hide Sidebar  (⌘B)"
              className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
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
                <span className="truncate">📁 {r.label}</span>
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
