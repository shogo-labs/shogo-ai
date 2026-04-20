import { useCallback, useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ActivityBar } from "./ActivityBar";
import { FileTree } from "./FileTree";
import { EditorTabs } from "./EditorTabs";
import { Breadcrumbs } from "./Breadcrumbs";
import { StatusBar } from "./StatusBar";
import { BottomPanel } from "./BottomPanel";
import { CodeEditor } from "./CodeEditor";
import { MOCK_FILES, MOCK_TREE } from "./mockFs";
import type { ActivityId, OpenFile, TreeNode } from "./types";
import { Search, GitBranch, Bot, Settings } from "lucide-react";

export function Workbench() {
  const [activity, setActivity] = useState<ActivityId>("files");
  const [open, setOpen] = useState<OpenFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  const active = useMemo(
    () => open.find((f) => f.id === activeId) ?? null,
    [open, activeId],
  );

  const handleOpenFile = useCallback((node: TreeNode) => {
    if (node.kind !== "file") return;
    setOpen((prev) => {
      if (prev.some((f) => f.id === node.path)) return prev;
      const content = MOCK_FILES[node.path] ?? "";
      return [
        ...prev,
        {
          id: node.path,
          name: node.name,
          path: node.path,
          language: node.language ?? "plaintext",
          content,
          dirty: false,
        },
      ];
    });
    setActiveId(node.path);
  }, []);

  const handleChange = (val: string) => {
    if (!active) return;
    setOpen((prev) =>
      prev.map((f) =>
        f.id === active.id
          ? { ...f, content: val, dirty: val !== (MOCK_FILES[f.path] ?? "") }
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

  const handleSave = useCallback(() => {
    if (!active) return;
    MOCK_FILES[active.path] = active.content;
    setOpen((prev) =>
      prev.map((f) => (f.id === active.id ? { ...f, dirty: false } : f)),
    );
  }, [active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
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

  useEffect(() => {
    if (open.length === 0) {
      const first = MOCK_TREE[0]?.children?.[0]?.children?.[0];
      if (first) handleOpenFile(first);
    }
  }, []);

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
        </div>
        <div className="flex items-center gap-3 text-[#858585]">
          <span>⌘P Quick Open</span>
          <span>⌘⇧P Commands</span>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <ActivityBar active={activity} onSelect={setActivity} />

        <Group orientation="horizontal" className="flex-1 flex">
          <Panel id="sidebar" defaultSize={18} minSize={12} maxSize={40}>
            <div className="h-full bg-[#252526] border-r border-[#2a2a2a]">
              {activity === "files" && (
                <FileTree
                  tree={MOCK_TREE}
                  activePath={active?.path ?? null}
                  onOpen={handleOpenFile}
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
                  <div className="flex-1 min-h-0">
                    {active ? (
                      <CodeEditor
                        value={active.content}
                        language={active.language}
                        onChange={handleChange}
                        onCursor={(line, col) => setCursor({ line, col })}
                      />
                    ) : (
                      <EmptyState />
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
      <div className="text-[14px]">Shogo IDE — Phase 1 prototype</div>
      <div className="flex gap-6 text-[12px]">
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">⌘P</kbd> Open file
        </span>
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">⌘⇧P</kbd> Commands
        </span>
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">⌘J</kbd> Toggle panel
        </span>
      </div>
    </div>
  );
}
