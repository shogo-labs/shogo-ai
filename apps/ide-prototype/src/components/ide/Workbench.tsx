import { useCallback, useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ActivityBar } from "./ActivityBar";
import { FileTree } from "./FileTree";
import { EditorTabs } from "./EditorTabs";
import { Breadcrumbs } from "./Breadcrumbs";
import { StatusBar } from "./StatusBar";
import { BottomPanel } from "./BottomPanel";
import { CodeEditor } from "./CodeEditor";
import type { ActivityId, OpenFile, TreeNode } from "./types";
import { agentFs } from "./workspace/agentFs";
import { Search, GitBranch, Bot, Settings, RefreshCw, AlertTriangle } from "lucide-react";

export function Workbench() {
  const [activity, setActivity] = useState<ActivityId>("files");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [toast, setToast] = useState<string | null>(null);

  const active = useMemo(
    () => open.find((f) => f.id === activeId) ?? null,
    [open, activeId],
  );

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
      setToast(`Saved ${active.name}`);
      window.setTimeout(() => setToast(null), 1400);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast(`Save failed: ${msg}`);
      window.setTimeout(() => setToast(null), 3000);
    }
  }, [active]);

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
            Phase 2 · live FS
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

        <Group orientation="horizontal" className="flex-1 flex">
          <Panel id="sidebar" defaultSize={18} minSize={12} maxSize={40}>
            <div className="h-full bg-[#252526] border-r border-[#2a2a2a]">
              {activity === "files" && (
                <FilesPane
                  tree={tree}
                  loading={treeLoading}
                  error={treeError}
                  activePath={active?.path ?? null}
                  onOpen={handleOpenFile}
                  onRefresh={loadTree}
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
          </Panel>

          <Separator className="w-px bg-[#2a2a2a] hover:bg-[#0078d4] transition-colors cursor-col-resize" />

          <Panel id="main" minSize={30}>
            <Group orientation="vertical" className="h-full flex flex-col">
              <Panel id="editor" defaultSize={panelOpen ? 70 : 100} minSize={30}>
                <div className="flex h-full flex-col bg-[#1e1e1e]">
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
              </Panel>

              {panelOpen && (
                <>
                  <Separator className="h-px bg-[#2a2a2a] hover:bg-[#0078d4] transition-colors cursor-row-resize" />
                  <Panel id="bottom" defaultSize={30} minSize={10}>
                    <BottomPanel onClose={() => setPanelOpen(false)} />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
        </Group>
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
  onOpen,
  onRefresh,
}: {
  tree: TreeNode[];
  loading: boolean;
  error: string | null;
  activePath: string | null;
  onOpen: (n: TreeNode) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#858585]">
          Explorer
        </span>
        <button
          onClick={onRefresh}
          title="Refresh"
          className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
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
        <FileTree tree={tree} activePath={activePath} onOpen={onOpen} />
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
      <div className="text-[14px]">Shogo IDE — Phase 2 · connected to agent workspace</div>
      <div className="flex gap-6 text-[12px]">
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">⌘S</kbd> Save to disk
        </span>
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">⌘W</kbd> Close
        </span>
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">⌘J</kbd> Toggle panel
        </span>
      </div>
      <div className="text-[11px] text-[#555]">Click a file in the tree →</div>
    </div>
  );
}
