import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { useResizable, VerticalSplit, HorizontalSplit } from "./Splitter";
import { ActivityBar } from "./ActivityBar";
import { FileTree, type FileTreeHandlers } from "./FileTree";
import { StatusBar } from "./StatusBar";
import { EditorGroupView } from "./EditorGroup";
import { Palette, type PaletteItem } from "./Palette";
import { BottomPanel } from "./BottomPanel";
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
import { useLiveAgentEdits, type LiveConflict } from "./useLiveAgentEdits";
import { AgentEditBanner } from "./AgentEditBanner";
import { applyAgentEdit, type MonacoNs } from "./agentEditAnimation";
import { FIX_IN_AGENT_EVENT, type FixInAgentPayload } from "./agentFixProvider";
import type { WorkspaceService } from "./workspace/types";
// Workspace services are injected by the parent (WorkspaceService impls per root).
import { isFsaSupported, pickDirectory, ensurePermission, LocalFs } from "./workspace/localFs";
import { saveRoot, listRoots, deleteRoot, touchRoot } from "./workspace/handleStore";
import { matchesShortcut, type Command } from "./commands";
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
const BINARY_EXTENSIONS = new Set([
  "png","jpg","jpeg","gif","webp","bmp","ico","avif","heic","tiff","tif",
  "pdf","zip","gz","tar","tgz","bz2","xz","7z","rar",
  "mp3","mp4","m4a","m4v","mov","avi","mkv","webm","wav","flac","ogg","aac",
  "woff","woff2","ttf","otf","eot",
  "exe","dll","so","dylib","bin","class","jar","wasm",
  "sqlite","db","pack","idx","psd","ai","sketch","fig",
]);

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
}: {
  agentService: WorkspaceService;
  agentLabel?: string;
  projectId?: string | null;
}) {
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

  const [bottomPanelOpen, setBottomPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("shogo.ide.bottomPanelOpen") === "true";
    } catch { /* ignore */ }
    return false;
  });
  useEffect(() => {
    try {
      localStorage.setItem("shogo.ide.bottomPanelOpen", String(bottomPanelOpen));
    } catch { /* ignore */ }
  }, [bottomPanelOpen]);

  // Nonce incremented on each ⌘⇧` press / "New Terminal" command. Terminal
  // component subscribes and creates a fresh session whenever it changes.
  const [newTerminalNonce, setNewTerminalNonce] = useState(0);
  const requestNewTerminal = useCallback(() => {
    setBottomPanelOpen(true);
    setNewTerminalNonce((n) => n + 1);
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
  // Bottom panel height: dragging the horizontal split grows the panel *upward*,
  // so we invert the delta direction by using the pane's own height state.
  const [bottomPanelSize, setBottomPanelSize] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("shogo.ide.bottomPanelSize");
      if (raw) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n)) return Math.min(600, Math.max(120, n));
      }
    } catch { /* ignore */ }
    return 260;
  });
  useEffect(() => {
    try {
      localStorage.setItem("shogo.ide.bottomPanelSize", String(bottomPanelSize));
    } catch { /* ignore */ }
  }, [bottomPanelSize]);

  const editorRefs = useRef<Record<string, editor.IStandaloneCodeEditor>>({});
  const monacoNsRef = useRef<MonacoNs | null>(null);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveIdForAutosaveRef = useRef<string | null>(null);
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

  // Keep open editors in sync with agent filesystem writes (Cursor-style).
  // Only hooks into the "agent" workspace; local folders never emit events.
  const refreshAgentTree = useCallback(() => {
    void loadRoot("agent");
  }, [loadRoot]);
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
      const ext = node.name.toLowerCase().split(".").pop() ?? "";
      if (BINARY_EXTENSIONS.has(ext)) {
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
        language: node.language ?? "plaintext",
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


  const handleChangeFor = (groupIdx: number) => (val: string) => {
    updateGroup(groupIdx, (g) => ({
      ...g,
      files: g.files.map((f) =>
        f.id === g.activeId ? { ...f, content: val, dirty: val !== f.savedContent } : f,
      ),
    }));
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
    }),
    [handleOpenFile, handleCreate, handleRenameNode, handleDeleteNode, handleMove],
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

  return (
    <div className="flex h-full w-full min-w-0 min-h-0 flex-col bg-[#1e1e1e] text-white overflow-hidden">
      {/* Title bar */}
      <div className="flex h-9 items-center justify-between border-b border-[#2a2a2a] bg-[#1a1a1a] px-3 text-[12px]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[#cccccc] shrink-0 font-medium">shogo-ai</span>
          <span className="text-[#858585] shrink-0 hidden sm:inline">—</span>
          <span className="text-[#858585] truncate max-w-[40vw]">
            {roots.length === 1 ? roots[0].label : `${roots.length} workspaces`}
          </span>
        </div>
        <div className="hidden lg:flex items-center gap-3 text-[#858585]">
          <span>⌘P files</span>
          <span>⌘⇧P commands</span>
          <span>⌘⇧F search</span>
          <span>⌘B sidebar</span>
          <span>⌘J panel</span>
          <span className="hidden xl:inline">⌘⇧O open folder</span>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <ActivityBar
          active={activity}
          sidebarOpen={sidebarOpen}
          terminalOpen={bottomPanelOpen}
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
                className="h-full bg-[#252526] overflow-hidden"
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
                  />
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
                        if (monaco) monacoNsRef.current = monaco;
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
                <div className="pointer-events-none absolute bottom-4 right-4 z-40 rounded bg-[#0078d4] px-3 py-1.5 text-[12px] text-white shadow-lg">
                  {toast}
                </div>
              )}
            </div>

            {bottomPanelOpen ? (
              <>
                <HorizontalSplit
                  onMouseDown={(e) => {
                    const startY = e.clientY;
                    const startSize = bottomPanelSize;
                    const move = (ev: MouseEvent) => {
                      const delta = startY - ev.clientY;
                      const next = Math.min(800, Math.max(120, startSize + delta));
                      setBottomPanelSize(next);
                    };
                    const up = () => {
                      window.removeEventListener("mousemove", move);
                      window.removeEventListener("mouseup", up);
                      document.body.style.cursor = "";
                      document.body.style.userSelect = "";
                    };
                    window.addEventListener("mousemove", move);
                    window.addEventListener("mouseup", up);
                    document.body.style.cursor = "row-resize";
                    document.body.style.userSelect = "none";
                    e.preventDefault();
                  }}
                  onDoubleClick={() => setBottomPanelSize(260)}
                />
                <div style={{ height: bottomPanelSize, flexShrink: 0 }} className="min-h-0">
                  <BottomPanel
                    projectId={projectId ?? null}
                    newSessionNonce={newTerminalNonce}
                    onClose={() => setBottomPanelOpen(false)}
                  />
                </div>
              </>
            ) : (
              /*
               * Closed-state peek handle. Sits just above the status bar as a
               * thin strip; hover reveals the accent + "grab" cursor so users
               * can find it without reading docs.
               *
               * Behaviour:
               *   - Click (tiny drag < 6px): open at the remembered size.
               *   - Drag upward: open with a size that tracks the pointer, so
               *     the panel follows your mouse like VS Code / IntelliJ do
               *     when dragging the panel border up from the status bar.
               */
              <BottomPeekHandle
                onOpen={(sizeOrNull) => {
                  if (sizeOrNull != null) setBottomPanelSize(sizeOrNull);
                  setBottomPanelOpen(true);
                }}
                onPreview={(size) => setBottomPanelSize(size)}
              />
            )}
            </div>

          </div>
        </div>
      </div>

      <StatusBar
        language={active?.language ?? "—"}
        line={cursor.line}
        col={cursor.col}
        saved={!active?.dirty}
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
    </div>
  );
}

/**
 * Invisible-until-hovered strip that lives above the status bar when the
 * bottom panel is closed. Lets users pull the panel up by dragging — the
 * standard IDE affordance — without adding visual weight to the chrome.
 *
 * Callback contract:
 *   - onPreview(size)  live during drag so the panel can follow the cursor
 *     before the mouseup. Size is clamped to sane min/max.
 *   - onOpen(size|null) fires on mouseup / click:
 *       • null  → treat as a click (drag distance < CLICK_SLOP). Caller
 *                 should open at whatever size it was already at.
 *       • number → the final drag size. Caller should set size + open.
 */
function BottomPeekHandle({
  onPreview,
  onOpen,
}: {
  onPreview: (size: number) => void;
  onOpen: (size: number | null) => void;
}) {
  const MIN_SIZE = 120;
  const MAX_SIZE = 800;
  const CLICK_SLOP = 6;
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Drag up to open panel"
      title="Drag up to open panel  (⌘J)"
      className="group relative h-[3px] shrink-0 cursor-row-resize select-none"
      onMouseDown={(e) => {
        // Only react to the primary button — right-click / middle-click have
        // their own meanings and shouldn't hijack the panel.
        if (e.button !== 0) return;
        e.preventDefault();
        const startY = e.clientY;
        let lastSize: number | null = null;
        let moved = false;
        const move = (ev: MouseEvent) => {
          const delta = startY - ev.clientY;
          if (!moved && Math.abs(delta) < CLICK_SLOP) return;
          moved = true;
          const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, delta));
          lastSize = size;
          onPreview(size);
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          onOpen(moved ? lastSize : null);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      }}
    >
      {/* Fat invisible hit-zone on top so users can grab it without a pixel
          perfect aim. Visible 3px strip is the bottom edge of the editor
          area; pointer enters pick up the accent color for discoverability. */}
      <div
        aria-hidden
        className="absolute inset-x-0 -top-[4px] bottom-0 group-hover:bg-[#0078d4]/60 transition-colors"
      />
    </div>
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
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#858585]">
          Explorer
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onOpenFolder}
            title={fsaSupported ? "Add local folder…" : "Local folders require Chrome or Edge"}
            disabled={!fsaSupported}
            className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FolderOpen size={13} />
          </button>
          {fsaSupported && (
            <button
              onClick={onRestore}
              title="Reopen recent local folder"
              className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
            >
              <History size={13} />
            </button>
          )}
          <button
            onClick={() => onNew("file")}
            title="New File"
            className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            <FilePlus size={13} />
          </button>
          <button
            onClick={() => onNew("dir")}
            title="New Folder"
            className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            <FolderPlus size={13} />
          </button>
          <button
            onClick={onRefresh}
            title="Refresh All"
            className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
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
        <div className="px-4 py-3 text-[12px] text-[#f48771]">
          <div className="flex items-center gap-1 mb-1">
            <AlertTriangle size={13} /> {anyError.label}
          </div>
          <div className="text-[#858585]">{anyError.error}</div>
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
        <div className="border-t border-[#2a2a2a] px-3 py-2">
          {roots
            .filter((r) => r.kind === "local")
            .map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-2 rounded px-1 py-[2px] text-[11px] text-[#858585] hover:bg-[#2a2a2a]"
              >
                <span className="truncate">📁 {r.label}</span>
                <button
                  onClick={() => onCloseRoot(r.id)}
                  className="rounded p-[2px] hover:bg-[#ffffff1a] hover:text-white"
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
      <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[#858585]">
        {title}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-[#858585]">
        <div className="text-[#4ec9b0]">{icon}</div>
        <div className="text-[13px]">{hint}</div>
      </div>
    </div>
  );
}
