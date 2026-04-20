import { useCallback, useEffect, useMemo, useState } from "react";
import { useResizable, VerticalSplit, HorizontalSplit } from "./Splitter";
import { ActivityBar } from "./ActivityBar";
import { FileTree, type FileTreeHandlers } from "./FileTree";
import { EditorTabs } from "./EditorTabs";
import { Breadcrumbs } from "./Breadcrumbs";
import { StatusBar } from "./StatusBar";
import { BottomPanel } from "./BottomPanel";
import { CodeEditor } from "./CodeEditor";
import type { ActivityId, OpenFile, TreeNode } from "./types";
import { agentFs } from "./workspace/agentFs";
import {
  Search,
  GitBranch,
  Bot,
  Settings,
  RefreshCw,
  AlertTriangle,
  FilePlus,
  FolderPlus,
} from "lucide-react";

export function Workbench() {
  const [activity, setActivity] = useState<ActivityId>("files");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const sidebarSplit = useResizable({ initial: 260, min: 180, max: 520, direction: "horizontal" });
  const bottomSplit = useResizable({ initial: 220, min: 80, max: 500, direction: "vertical" });
  const [toast, setToast] = useState<string | null>(null);
  const [newRequest, setNewRequest] = useState<{ kind: "file" | "dir"; nonce: number } | null>(
    null,
  );

  const active = useMemo(
    () => open.find((f) => f.id === activeId) ?? null,
    [open, activeId],
  );

  const showToast = useCallback((msg: string, ms = 1400) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), ms);
  }, []);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      const nodes = await agentFs.listTree("", 4);
      setTree(nodes);
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : String(err));
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const handleOpenFile = useCallback(async (node: TreeNode) => {
    if (node.kind !== "file") return;
    const existing = open.find((f) => f.id === node.path);
    if (existing) {
      setActiveId(node.path);
      return;
    }
    const placeholder: OpenFile = {
      id: node.path,
      name: node.name,
      path: node.path,
      language: node.language ?? "plaintext",
      content: "",
      savedContent: "",
      dirty: false,
      loading: true,
    };
    setOpen((prev) => [...prev, placeholder]);
    setActiveId(node.path);
    try {
      const file = await agentFs.readFile(node.path);
      setOpen((prev) =>
        prev.map((f) =>
          f.id === node.path
            ? {
                ...f,
                content: file.content,
                savedContent: file.content,
                language: file.language,
                loading: false,
              }
            : f,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOpen((prev) =>
        prev.map((f) =>
          f.id === node.path ? { ...f, loading: false, error: msg } : f,
        ),
      );
    }
  }, [open]);

  const handleChange = (val: string) => {
    if (!active) return;
    setOpen((prev) =>
      prev.map((f) =>
        f.id === active.id
          ? { ...f, content: val, dirty: val !== f.savedContent }
          : f,
      ),
    );
  };

  const handleClose = (id: string) => {
    setOpen((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((f) => f.id !== id);
      if (activeId === id) {
        setActiveId(next[Math.max(0, idx - 1)]?.id ?? null);
      }
      return next;
    });
  };

  const handleCreate = useCallback(
    async (parentPath: string, name: string, kind: "file" | "dir") => {
      const full = parentPath ? `${parentPath}/${name}` : name;
      try {
        if (kind === "dir") {
          await agentFs.mkdir(full);
          showToast(`Created folder ${name}`);
        } else {
          await agentFs.writeFile(full, "");
          showToast(`Created ${name}`);
        }
        await loadTree();
      } catch (err) {
        showToast(
          `Create failed: ${err instanceof Error ? err.message : String(err)}`,
          3000,
        );
      }
    },
    [loadTree, showToast],
  );

  const handleRenameNode = useCallback(
    async (node: TreeNode, newName: string) => {
      const parent = node.path.includes("/")
        ? node.path.slice(0, node.path.lastIndexOf("/"))
        : "";
      const to = parent ? `${parent}/${newName}` : newName;
      try {
        await agentFs.rename(node.path, to);
        showToast(`Renamed to ${newName}`);
        setOpen((prev) =>
          prev.map((f) =>
            f.path === node.path
              ? { ...f, id: to, path: to, name: newName }
              : f.path.startsWith(node.path + "/")
              ? {
                  ...f,
                  id: to + f.path.slice(node.path.length),
                  path: to + f.path.slice(node.path.length),
                }
              : f,
          ),
        );
        setActiveId((id) =>
          id === node.path
            ? to
            : id && id.startsWith(node.path + "/")
            ? to + id.slice(node.path.length)
            : id,
        );
        await loadTree();
      } catch (err) {
        showToast(
          `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
          3000,
        );
      }
    },
    [loadTree, showToast],
  );

  const handleDeleteNode = useCallback(
    async (node: TreeNode) => {
      try {
        await agentFs.remove(node.path);
        showToast(`Deleted ${node.name}`);
        setOpen((prev) =>
          prev.filter(
            (f) => f.path !== node.path && !f.path.startsWith(node.path + "/"),
          ),
        );
        setActiveId((id) =>
          id && (id === node.path || id.startsWith(node.path + "/")) ? null : id,
        );
        await loadTree();
      } catch (err) {
        showToast(
          `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
          3000,
        );
      }
    },
    [loadTree, showToast],
  );

  const handleMove = useCallback(
    async (from: TreeNode, toDir: TreeNode | null) => {
      const targetDir = toDir?.path ?? "";
      const currentParent = from.path.includes("/")
        ? from.path.slice(0, from.path.lastIndexOf("/"))
        : "";
      if (targetDir === currentParent) return;
      if (targetDir === from.path || targetDir.startsWith(from.path + "/")) {
        showToast("Can't move folder into itself", 2500);
        return;
      }
      const to = targetDir ? `${targetDir}/${from.name}` : from.name;
      try {
        await agentFs.rename(from.path, to);
        showToast(`Moved ${from.name}`);
        await loadTree();
      } catch (err) {
        showToast(
          `Move failed: ${err instanceof Error ? err.message : String(err)}`,
          3000,
        );
      }
    },
    [loadTree, showToast],
  );

  const treeHandlers: FileTreeHandlers = useMemo(
    () => ({
      onOpen: (n) => void handleOpenFile(n),
      onCreate: handleCreate,
      onRename: handleRenameNode,
      onDelete: handleDeleteNode,
      onMove: handleMove,
    }),
    [handleOpenFile, handleCreate, handleRenameNode, handleDeleteNode, handleMove],
  );

  const handleSave = useCallback(async () => {
    if (!active || !active.dirty) return;
    try {
      await agentFs.writeFile(active.path, active.content);
      setOpen((prev) =>
        prev.map((f) =>
          f.id === active.id
            ? { ...f, dirty: false, savedContent: f.content }
            : f,
        ),
      );
      showToast(`Saved ${active.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Save failed: ${msg}`, 3000);
    }
  }, [active, showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
      if (meta && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeId) handleClose(activeId);
      }
      if (meta && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setPanelOpen((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, activeId]);

  return (
    <div className="flex h-screen w-screen flex-col bg-[#1e1e1e] text-white overflow-hidden">
      <div className="flex h-9 items-center justify-between border-b border-[#2a2a2a] bg-[#1a1a1a] px-3 text-[12px]">
        <div className="flex items-center gap-3">
          <span className="inline-block h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="inline-block h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="inline-block h-3 w-3 rounded-full bg-[#28c840]" />
          <span className="ml-3 text-[#cccccc]">shogo-ai</span>
          <span className="text-[#858585]">—</span>
          <span className="text-[#858585]">feat/shogo-IDE</span>
          <span className="ml-3 rounded bg-[#0078d4]/30 px-1.5 py-[1px] text-[10px] text-[#75beff]">
            Phase 3 · CRUD
          </span>
        </div>
        <div className="flex items-center gap-3 text-[#858585]">
          <span>⌘S Save</span>
          <span>⌘W Close</span>
          <span>⌘J Panel</span>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <ActivityBar active={activity} onSelect={setActivity} />

        <div className="flex flex-1 min-w-0">
          <div
            style={{ width: sidebarSplit.size, flexShrink: 0 }}
            className="h-full bg-[#252526]"
          >
            {activity === "files" && (
              <FilesPane
                tree={tree}
                loading={treeLoading}
                error={treeError}
                activePath={active?.path ?? null}
                handlers={treeHandlers}
                newRequest={newRequest}
                onRefresh={loadTree}
                onNew={(kind) => setNewRequest({ kind, nonce: Date.now() })}
              />
            )}
            {activity === "search" && (
              <Placeholder icon={<Search size={18} />} title="Search" hint="Coming in Phase 6" />
            )}
            {activity === "git" && (
              <Placeholder icon={<GitBranch size={18} />} title="Source Control" hint="Coming soon" />
            )}
            {activity === "agent" && (
              <Placeholder icon={<Bot size={18} />} title="Shogo Agent" hint="Live edits arrive in Phase 7" />
            )}
            {activity === "settings" && (
              <Placeholder icon={<Settings size={18} />} title="Settings" hint="JSON + GUI in Phase 6" />
            )}
          </div>

          <VerticalSplit onMouseDown={sidebarSplit.onMouseDown} />

          <div className="flex flex-1 min-w-0 flex-col">
            <div className="flex flex-1 min-h-0 flex-col bg-[#1e1e1e]">
              <EditorTabs
                files={open}
                activeId={activeId}
                onSelect={setActiveId}
                onClose={handleClose}
              />
              {active && <Breadcrumbs path={active.path} />}
              <div className="flex-1 min-h-0 relative">
                {active ? (
                  active.loading ? (
                    <LoadingState name={active.name} />
                  ) : active.error ? (
                    <ErrorState name={active.name} message={active.error} />
                  ) : (
                    <CodeEditor
                      value={active.content}
                      language={active.language}
                      onChange={handleChange}
                      onCursor={(line, col) => setCursor({ line, col })}
                    />
                  )
                ) : (
                  <EmptyState />
                )}
                {toast && (
                  <div className="absolute bottom-3 right-4 rounded bg-[#0078d4] px-3 py-1.5 text-[12px] text-white shadow-lg">
                    {toast}
                  </div>
                )}
              </div>
            </div>

            {panelOpen && (
              <>
                <HorizontalSplit onMouseDown={bottomSplit.onMouseDown} />
                <div style={{ height: bottomSplit.size, flexShrink: 0 }}>
                  <BottomPanel onClose={() => setPanelOpen(false)} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <StatusBar
        branch="feat/shogo-IDE"
        language={active?.language ?? "—"}
        line={cursor.line}
        col={cursor.col}
        problems={0}
        warnings={0}
        saved={!active?.dirty}
      />
    </div>
  );
}

function FilesPane({
  tree,
  loading,
  error,
  activePath,
  handlers,
  newRequest,
  onRefresh,
  onNew,
}: {
  tree: TreeNode[];
  loading: boolean;
  error: string | null;
  activePath: string | null;
  handlers: FileTreeHandlers;
  newRequest: { kind: "file" | "dir"; nonce: number } | null;
  onRefresh: () => void;
  onNew: (kind: "file" | "dir") => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#858585]">
          Explorer
        </span>
        <div className="flex items-center gap-1">
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
            title="Refresh"
            className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      {error ? (
        <div className="px-4 py-3 text-[12px] text-[#f48771]">
          <div className="flex items-center gap-1 mb-1">
            <AlertTriangle size={13} /> Could not load workspace
          </div>
          <div className="text-[#858585]">{error}</div>
        </div>
      ) : loading && tree.length === 0 ? (
        <div className="flex-1 space-y-2 px-4 py-2">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className="h-3 animate-pulse rounded bg-[#2a2a2a]"
              style={{ width: `${60 + ((i * 13) % 30)}%` }}
            />
          ))}
        </div>
      ) : (
        <FileTree
          tree={tree}
          activePath={activePath}
          handlers={handlers}
          newRequest={newRequest}
        />
      )}
    </div>
  );
}

function LoadingState({ name }: { name: string }) {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-[#858585]">
      Loading {name}…
    </div>
  );
}

function ErrorState({ name, message }: { name: string; message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-[#f48771]">
      <AlertTriangle size={24} />
      <div className="text-[13px]">Could not open {name}</div>
      <div className="text-[12px] text-[#858585]">{message}</div>
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

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-[#858585]">
      <div className="text-5xl">⚡</div>
      <div className="text-[14px]">Shogo IDE — Phase 3 · full file CRUD</div>
      <div className="flex gap-6 text-[12px]">
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">⌘S</kbd> Save
        </span>
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">F2</kbd> Rename
        </span>
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">Delete</kbd> Remove
        </span>
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">Right-click</kbd> Menu
        </span>
      </div>
      <div className="text-[11px] text-[#555]">
        Drag files between folders · click a file in the tree →
      </div>
    </div>
  );
}
