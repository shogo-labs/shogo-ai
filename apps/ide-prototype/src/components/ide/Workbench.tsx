import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { useResizable, VerticalSplit, HorizontalSplit } from "./Splitter";
import { ActivityBar } from "./ActivityBar";
import { FileTree, type FileTreeHandlers } from "./FileTree";
import { StatusBar } from "./StatusBar";
import { BottomPanel } from "./BottomPanel";
import { EditorGroupView } from "./EditorGroup";
import { Palette, type PaletteItem } from "./Palette";
import type { ActivityId, EditorGroup, OpenFile, TreeNode } from "./types";
import { agentFs } from "./workspace/agentFs";
import { matchesShortcut, type Command } from "./commands";
import {
  Search,
  GitBranch,
  Bot,
  Settings,
  RefreshCw,
  AlertTriangle,
  FilePlus,
  FolderPlus,
  SplitSquareHorizontal,
} from "lucide-react";

let groupSeq = 1;
const newGroupId = () => `g${groupSeq++}`;

function flattenFiles(tree: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of tree) {
    if (n.kind === "file") out.push(n);
    else if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

export function Workbench() {
  const [activity, setActivity] = useState<ActivityId>("files");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [groups, setGroups] = useState<EditorGroup[]>([
    { id: newGroupId(), files: [], activeId: null },
  ]);
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);

  const [panelOpen, setPanelOpen] = useState(true);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [toast, setToast] = useState<string | null>(null);
  const [newRequest, setNewRequest] = useState<{ kind: "file" | "dir"; nonce: number } | null>(
    null,
  );
  const [palette, setPalette] = useState<"command" | "file" | null>(null);

  const sidebarSplit = useResizable({ initial: 260, min: 180, max: 520, direction: "horizontal" });
  const bottomSplit = useResizable({ initial: 220, min: 80, max: 500, direction: "vertical" });
  const groupSplit = useResizable({ initial: 0.5, min: 0.2, max: 0.8, direction: "horizontal" });

  const editorRefs = useRef<Record<string, editor.IStandaloneCodeEditor>>({});

  const activeGroup = groups[activeGroupIdx] ?? groups[0];
  const active = activeGroup?.files.find((f) => f.id === activeGroup.activeId) ?? null;

  const showToast = useCallback((msg: string, ms = 1400) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), ms);
  }, []);

  // ─── Tree ────────────────────────────────────────────────────────────
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

  // ─── Group helpers ───────────────────────────────────────────────────
  const updateGroup = useCallback(
    (idx: number, updater: (g: EditorGroup) => EditorGroup) => {
      setGroups((prev) => prev.map((g, i) => (i === idx ? updater(g) : g)));
    },
    [],
  );

  const findOpenLocation = useCallback(
    (path: string): { groupIdx: number; file: OpenFile } | null => {
      for (let i = 0; i < groups.length; i++) {
        const f = groups[i].files.find((x) => x.path === path);
        if (f) return { groupIdx: i, file: f };
      }
      return null;
    },
    [groups],
  );

  const openFileInGroup = useCallback(
    async (node: TreeNode, groupIdx: number) => {
      if (node.kind !== "file") return;
      const hit = findOpenLocation(node.path);
      if (hit) {
        setActiveGroupIdx(hit.groupIdx);
        updateGroup(hit.groupIdx, (g) => ({ ...g, activeId: node.path }));
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
      updateGroup(groupIdx, (g) => ({
        ...g,
        files: [...g.files, placeholder],
        activeId: node.path,
      }));
      setActiveGroupIdx(groupIdx);
      try {
        const file = await agentFs.readFile(node.path);
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            files: g.files.map((f) =>
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
          })),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            files: g.files.map((f) =>
              f.id === node.path ? { ...f, loading: false, error: msg } : f,
            ),
          })),
        );
      }
    },
    [findOpenLocation, updateGroup],
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

  const closeInGroup = useCallback(
    (groupIdx: number, id: string) => {
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
        const newGroup = { ...g, files: nextFiles, activeId: nextActive };
        // Remove empty secondary group
        if (nextFiles.length === 0 && prev.length > 1 && groupIdx > 0) {
          const without = prev.filter((_, i) => i !== groupIdx);
          setActiveGroupIdx((ai) => Math.min(ai, without.length - 1));
          return without;
        }
        return prev.map((gg, i) => (i === groupIdx ? newGroup : gg));
      });
    },
    [],
  );

  const togglePinInGroup = useCallback((groupIdx: number, id: string) => {
    setGroups((prev) =>
      prev.map((g, i) =>
        i === groupIdx
          ? {
              ...g,
              files: g.files.map((f) => (f.id === id ? { ...f, pinned: !f.pinned } : f)),
            }
          : g,
      ),
    );
  }, []);

  // ─── CRUD (delegated to server + sync open tabs) ─────────────────────
  const handleCreate = useCallback(
    async (parentPath: string, name: string, kind: "file" | "dir") => {
      const full = parentPath ? `${parentPath}/${name}` : name;
      try {
        if (kind === "dir") await agentFs.mkdir(full);
        else await agentFs.writeFile(full, "");
        showToast(kind === "dir" ? `Created folder ${name}` : `Created ${name}`);
        await loadTree();
      } catch (err) {
        showToast(`Create failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      }
    },
    [loadTree, showToast],
  );

  const rewriteOpenPaths = (from: string, to: string) => {
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        activeId:
          g.activeId === from
            ? to
            : g.activeId && g.activeId.startsWith(from + "/")
            ? to + g.activeId.slice(from.length)
            : g.activeId,
        files: g.files.map((f) =>
          f.path === from
            ? { ...f, id: to, path: to, name: to.split("/").pop()! }
            : f.path.startsWith(from + "/")
            ? {
                ...f,
                id: to + f.path.slice(from.length),
                path: to + f.path.slice(from.length),
              }
            : f,
        ),
      })),
    );
  };

  const removeOpenPaths = (prefix: string) => {
    setGroups((prev) =>
      prev.map((g) => {
        const files = g.files.filter(
          (f) => f.path !== prefix && !f.path.startsWith(prefix + "/"),
        );
        return {
          ...g,
          files,
          activeId:
            g.activeId && (g.activeId === prefix || g.activeId.startsWith(prefix + "/"))
              ? files[0]?.id ?? null
              : g.activeId,
        };
      }),
    );
  };

  const handleRenameNode = useCallback(
    async (node: TreeNode, newName: string) => {
      const parent = node.path.includes("/")
        ? node.path.slice(0, node.path.lastIndexOf("/"))
        : "";
      const to = parent ? `${parent}/${newName}` : newName;
      try {
        await agentFs.rename(node.path, to);
        showToast(`Renamed to ${newName}`);
        rewriteOpenPaths(node.path, to);
        await loadTree();
      } catch (err) {
        showToast(`Rename failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      }
    },
    [loadTree, showToast],
  );

  const handleDeleteNode = useCallback(
    async (node: TreeNode) => {
      try {
        await agentFs.remove(node.path);
        showToast(`Deleted ${node.name}`);
        removeOpenPaths(node.path);
        await loadTree();
      } catch (err) {
        showToast(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
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
        rewriteOpenPaths(from.path, to);
        await loadTree();
      } catch (err) {
        showToast(`Move failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
      }
    },
    [loadTree, showToast],
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
  const handleSave = useCallback(async () => {
    if (!active || !active.dirty) return;
    try {
      await agentFs.writeFile(active.path, active.content);
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          files: g.files.map((f) =>
            f.id === active.id ? { ...f, dirty: false, savedContent: f.content } : f,
          ),
        })),
      );
      showToast(`Saved ${active.name}`);
    } catch (err) {
      showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
    }
  }, [active, showToast]);

  const handleSaveAll = useCallback(async () => {
    const dirty = groups.flatMap((g) => g.files.filter((f) => f.dirty));
    if (!dirty.length) {
      showToast("Nothing to save");
      return;
    }
    try {
      await Promise.all(dirty.map((f) => agentFs.writeFile(f.path, f.content)));
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          files: g.files.map((f) =>
            f.dirty ? { ...f, dirty: false, savedContent: f.content } : f,
          ),
        })),
      );
      showToast(`Saved ${dirty.length} file${dirty.length === 1 ? "" : "s"}`);
    } catch (err) {
      showToast(`Save all failed: ${err instanceof Error ? err.message : String(err)}`, 3000);
    }
  }, [groups, showToast]);

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
    setGroups((prev) => [
      ...prev,
      { id: newGroupId(), files: [cloned], activeId: cloned.id },
    ]);
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

  // ─── Line jump ───────────────────────────────────────────────────────
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

  // ─── Commands ────────────────────────────────────────────────────────
  const commands: Command[] = useMemo(
    () => [
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
      {
        id: "file.newFile",
        label: "Explorer: New File",
        run: () => setNewRequest({ kind: "file", nonce: Date.now() }),
      },
      {
        id: "file.newFolder",
        label: "Explorer: New Folder",
        run: () => setNewRequest({ kind: "dir", nonce: Date.now() }),
      },
      { id: "explorer.refresh", label: "Explorer: Refresh Tree", run: () => void loadTree() },
      { id: "view.togglePanel", label: "View: Toggle Panel", shortcut: "⌘J", run: () => setPanelOpen((p) => !p) },
      {
        id: "view.splitRight",
        label: "View: Split Editor Right",
        shortcut: "⌘\\",
        run: splitRight,
      },
      {
        id: "view.closeOtherGroup",
        label: "View: Close Other Editor Group",
        run: closeOtherGroup,
      },
      {
        id: "view.focusNextGroup",
        label: "View: Focus Next Editor Group",
        shortcut: "⌘K ⌘→",
        run: focusNextGroup,
      },
      {
        id: "tab.togglePin",
        label: "Tab: Toggle Pin",
        shortcut: "⌘K ⇧Enter",
        run: () => {
          if (activeGroup?.activeId) togglePinInGroup(activeGroupIdx, activeGroup.activeId);
        },
      },
      {
        id: "goto.file",
        label: "Go to File…",
        shortcut: "⌘P",
        run: () => setPalette("file"),
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
    ],
    [
      handleSave,
      handleSaveAll,
      activeGroup,
      activeGroupIdx,
      closeInGroup,
      splitRight,
      closeOtherGroup,
      focusNextGroup,
      togglePinInGroup,
      gotoLine,
      loadTree,
    ],
  );

  const commandItems: PaletteItem[] = useMemo(
    () =>
      commands.map((c) => ({
        id: c.id,
        label: c.label,
        hint: c.shortcut,
        run: c.run,
      })),
    [commands],
  );

  // Files flattened for Quick Open
  const fileItems: PaletteItem[] = useMemo(() => {
    const flat = flattenFiles(tree);
    return flat.map((n) => ({
      id: n.path,
      label: n.name,
      sublabel: n.path,
      run: () => handleOpenFile(n),
    }));
  }, [tree, handleOpenFile]);

  // ─── Keyboard ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, { meta: true, shift: true, key: "p" })) {
        e.preventDefault();
        setPalette("command");
        return;
      }
      if (matchesShortcut(e, { meta: true, key: "p" })) {
        e.preventDefault();
        setPalette("file");
        return;
      }
      if (matchesShortcut(e, { meta: true, key: "s" })) {
        e.preventDefault();
        void handleSave();
        return;
      }
      if (matchesShortcut(e, { meta: true, alt: true, key: "s" })) {
        e.preventDefault();
        void handleSaveAll();
        return;
      }
      if (matchesShortcut(e, { meta: true, key: "w" })) {
        e.preventDefault();
        if (activeGroup?.activeId) closeInGroup(activeGroupIdx, activeGroup.activeId);
        return;
      }
      if (matchesShortcut(e, { meta: true, key: "j" })) {
        e.preventDefault();
        setPanelOpen((p) => !p);
        return;
      }
      if (matchesShortcut(e, { meta: true, key: "\\" })) {
        e.preventDefault();
        splitRight();
        return;
      }
      if (matchesShortcut(e, { meta: true, key: "g" })) {
        e.preventDefault();
        const input = prompt("Go to line:");
        const n = input && parseInt(input, 10);
        if (n && n > 0) gotoLine(n);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, handleSaveAll, activeGroup, activeGroupIdx, closeInGroup, splitRight, gotoLine]);

  // Quick Open supports ":NN" for line jump
  const quickOpenItems = useMemo<PaletteItem[]>(() => {
    // We intercept line-jump before filtering: if the query starts with ":",
    // the palette will only show a synthetic "Go to line" item.
    return fileItems;
  }, [fileItems]);

  return (
    <div className="flex h-screen w-screen flex-col bg-[#1e1e1e] text-white overflow-hidden">
      {/* Title bar */}
      <div className="flex h-9 items-center justify-between border-b border-[#2a2a2a] bg-[#1a1a1a] px-3 text-[12px]">
        <div className="flex items-center gap-3">
          <span className="inline-block h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="inline-block h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="inline-block h-3 w-3 rounded-full bg-[#28c840]" />
          <span className="ml-3 text-[#cccccc]">shogo-ai</span>
          <span className="text-[#858585]">—</span>
          <span className="text-[#858585]">feat/shogo-IDE</span>
          <span className="ml-3 rounded bg-[#0078d4]/30 px-1.5 py-[1px] text-[10px] text-[#75beff]">
            Phase 4 · palette & splits
          </span>
        </div>
        <div className="flex items-center gap-3 text-[#858585]">
          <span>⌘P files</span>
          <span>⌘⇧P commands</span>
          <span>⌘\ split</span>
        </div>
      </div>

      {/* Main row */}
      <div className="flex flex-1 min-h-0">
        <ActivityBar active={activity} onSelect={setActivity} />

        <div className="flex flex-1 min-w-0">
          {/* Sidebar */}
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

          {/* Editor area */}
          <div className="flex flex-1 min-w-0 flex-col">
            <div className="flex flex-1 min-h-0">
              {groups.map((g, i) => (
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
                    onChange={handleChangeFor(i)}
                    onCursor={(line, col) => setCursor({ line, col })}
                    onEditorMount={(ed) => {
                      editorRefs.current[g.id] = ed;
                    }}
                  />
                  {i === 0 && groups.length > 1 && (
                    <></>
                  )}
                </div>
              )).reduce<React.ReactNode[]>((acc, el, i) => {
                acc.push(el);
                if (i === 0 && groups.length > 1) {
                  acc.push(
                    <VerticalSplit
                      key={`split-${i}`}
                      onMouseDown={(e) => {
                        // proportional drag handler
                        const totalW =
                          (e.currentTarget.parentElement?.clientWidth ?? 1000) - 4;
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

              {/* Toast */}
              {toast && (
                <div className="pointer-events-none absolute bottom-16 right-6 z-40 rounded bg-[#0078d4] px-3 py-1.5 text-[12px] text-white shadow-lg">
                  {toast}
                </div>
              )}
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

      {palette === "command" && (
        <Palette
          placeholder="Type a command…"
          items={commandItems}
          onClose={() => setPalette(null)}
          emptyHint="No commands match"
        />
      )}
      {palette === "file" && (
        <QuickOpen
          fileItems={quickOpenItems}
          onClose={() => setPalette(null)}
          onLine={gotoLine}
        />
      )}
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

// keep the icon import used for the split-right command discoverability
void SplitSquareHorizontal;
