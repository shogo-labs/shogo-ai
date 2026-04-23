import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react-native";
import type { TreeNode } from "./types";
import { ContextMenu, type MenuEntry } from "./ContextMenu";

export interface FileTreeHandlers {
  onOpen: (node: TreeNode) => void;
  onCreate: (rootId: string, parentPath: string, name: string, kind: "file" | "dir") => Promise<void>;
  onRename: (node: TreeNode, newName: string) => Promise<void>;
  onDelete: (node: TreeNode) => Promise<void>;
  onMove: (from: TreeNode, toDir: TreeNode | null) => Promise<void>;
}

type FlatRow =
  | { kind: "node"; node: TreeNode; depth: number; parentPath: string }
  | { kind: "new"; depth: number; parentPath: string; mode: "file" | "dir" };

function flatten(
  tree: TreeNode[],
  expanded: Set<string>,
  depth = 0,
  parentPath = "",
  out: FlatRow[] = [],
): FlatRow[] {
  for (const n of tree) {
    out.push({ kind: "node", node: n, depth, parentPath });
    if (n.kind === "dir" && expanded.has(n.path) && n.children) {
      flatten(n.children, expanded, depth + 1, n.path, out);
    }
  }
  return out;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function iconFor(ext: string) {
  if (["ts", "tsx"].includes(ext)) return "text-[#3178c6]";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "text-[#f7df1e]";
  if (ext === "json") return "text-[#cbcb41]";
  if (ext === "md") return "text-[#519aba]";
  if (ext === "css") return "text-[#42a5f5]";
  if (ext === "html") return "text-[#e44d26]";
  if (ext === "prisma") return "text-[#a78bfa]";
  if (ext === "py") return "text-[#3572a5]";
  return "text-[color:var(--ide-accent-file-icon)]";
}

/** Stable key used across the selection state (root-aware so folder names
 *  collisions across roots don't stomp each other). */
const keyOf = (node: TreeNode) => `${node.rootId}::${node.path}`;

export function FileTree({
  tree,
  activePath,
  handlers,
  newRequest,
}: {
  tree: TreeNode[];
  activePath: string | null;
  handlers: FileTreeHandlers;
  newRequest?: { kind: "file" | "dir"; nonce: number; rootId?: string } | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const n of tree) if (n.kind === "dir") s.add(n.path);
    return s;
  });
  const [selected, setSelected] = useState<string | null>(null);
  /** Additional selected entries (stored by stable keyOf()). Always includes
   *  `selected` when it's set. Used for multi-select actions (Cmd/Shift+click).
   *  VS Code semantics: Cmd/Ctrl toggles a single entry, Shift extends a range
   *  between the anchor and the clicked row. */
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; draft: string } | null>(null);
  const [creating, setCreating] = useState<{
    rootId: string;
    parentPath: string;
    kind: "file" | "dir";
    draft: string;
  } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const base = flatten(tree, expanded);
    if (creating) {
      const insertIdx = creating.parentPath
        ? base.findIndex(
            (r) =>
              r.kind === "node" &&
              r.node.kind === "dir" &&
              r.node.path === creating.parentPath,
          )
        : -1;
      const newRow: FlatRow = {
        kind: "new",
        depth:
          insertIdx >= 0 && base[insertIdx].kind === "node"
            ? (base[insertIdx] as { depth: number }).depth + 1
            : 0,
        parentPath: creating.parentPath,
        mode: creating.kind,
      };
      if (insertIdx >= 0) {
        return [...base.slice(0, insertIdx + 1), newRow, ...base.slice(insertIdx + 1)];
      }
      return [newRow, ...base];
    }
    return base;
  }, [tree, expanded, creating]);

  /** Linear view of *visible* nodes used by keyboard nav and range selection. */
  const visibleNodes = useMemo(
    () =>
      rows
        .filter((r): r is Extract<FlatRow, { kind: "node" }> => r.kind === "node")
        .map((r) => r.node),
    [rows],
  );

  /** Prune selections that are no longer visible (e.g. after a parent was
   *  collapsed or the tree refreshed). Keeps behaviour predictable. */
  useEffect(() => {
    setMultiSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(visibleNodes.map(keyOf));
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (visible.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visibleNodes]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }, []);

  const expand = useCallback((path: string) => {
    setExpanded((prev) => {
      if (prev.has(path)) return prev;
      const n = new Set(prev);
      n.add(path);
      return n;
    });
  }, []);

  const openContextMenu = (e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    // If right-clicking on a row that's part of a multi-selection, preserve the
    // set so "Delete" / "Copy Path" can operate on everything at once.
    if (node && !multiSelected.has(keyOf(node))) {
      setSelected(node.path);
      setMultiSelected(new Set([keyOf(node)]));
      anchorRef.current = keyOf(node);
    }
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const beginCreate = useCallback(
    (rootId: string, parentPath: string, kind: "file" | "dir") => {
      if (parentPath) expand(parentPath);
      setCreating({ rootId, parentPath, kind, draft: "" });
    },
    [expand],
  );

  useEffect(() => {
    if (!newRequest) return;
    const n = selected ? findNode(tree, selected) : null;
    const rootId = n?.rootId ?? newRequest.rootId ?? tree[0]?.rootId ?? "agent";
    const parent = n ? (n.kind === "dir" ? n.path : parentOf(n.path)) : "";
    beginCreate(rootId, parent, newRequest.kind);
  }, [newRequest, beginCreate, selected, tree]);

  const commitCreate = async () => {
    if (!creating) return;
    const name = creating.draft.trim();
    const { rootId, parentPath, kind } = creating;
    setCreating(null);
    if (!name) return;
    try {
      await handlers.onCreate(rootId, parentPath, name, kind);
    } catch {
      /* toast handled by parent */
    }
  };

  const beginRename = (node: TreeNode) => {
    setRenaming({ path: node.path, draft: node.name });
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { path, draft } = renaming;
    const trimmed = draft.trim();
    setRenaming(null);
    if (!trimmed) return;
    const node = findNode(tree, path);
    if (!node || trimmed === node.name) return;
    try {
      await handlers.onRename(node, trimmed);
    } catch {
      /* toast */
    }
  };

  const selectedNodes = useMemo(() => {
    if (multiSelected.size === 0) return [] as TreeNode[];
    const byKey = new Map(visibleNodes.map((n) => [keyOf(n), n]));
    const out: TreeNode[] = [];
    for (const k of multiSelected) {
      const n = byKey.get(k);
      if (n) out.push(n);
    }
    return out;
  }, [multiSelected, visibleNodes]);

  const handleDelete = async (node: TreeNode) => {
    // Batch delete path: if the clicked node is part of a multi-selection of
    // >1 entries, confirm once and delete all (files + folders). Otherwise
    // fall back to the single-item confirm.
    const targets =
      multiSelected.size > 1 && multiSelected.has(keyOf(node))
        ? selectedNodes
        : [node];
    if (targets.length === 1) {
      const t = targets[0];
      if (!confirm(`Delete ${t.kind === "dir" ? "folder" : "file"} "${t.name}"?`)) return;
    } else {
      if (
        !confirm(
          `Delete ${targets.length} items? Folders will be removed recursively.`,
        )
      ) {
        return;
      }
    }
    for (const t of targets) {
      try {
        await handlers.onDelete(t);
      } catch {
        /* toast handled by parent */
      }
    }
    setMultiSelected(new Set());
    setSelected(null);
  };

  const openSelected = useCallback(() => {
    const files = selectedNodes.filter((n) => n.kind === "file");
    for (const f of files) handlers.onOpen(f);
  }, [selectedNodes, handlers]);

  /** Cmd/Ctrl-click toggles, Shift-click extends a range between anchor and
   *  the clicked row, plain click resets to a single-selection. */
  const handleRowClick = useCallback(
    (e: React.MouseEvent, node: TreeNode) => {
      e.stopPropagation();
      const k = keyOf(node);
      const meta = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      if (shift && anchorRef.current) {
        const keys = visibleNodes.map(keyOf);
        const a = keys.indexOf(anchorRef.current);
        const b = keys.indexOf(k);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const range = new Set(keys.slice(lo, hi + 1));
          setMultiSelected(range);
          setSelected(node.path);
        }
        return;
      }

      if (meta) {
        setMultiSelected((prev) => {
          const next = new Set(prev);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          return next;
        });
        anchorRef.current = k;
        setSelected(node.path);
        return;
      }

      anchorRef.current = k;
      setMultiSelected(new Set([k]));
      setSelected(node.path);
      if (node.kind === "dir") toggle(node.path);
      else handlers.onOpen(node);
    },
    [visibleNodes, toggle, handlers],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (renaming || creating) return;
      if (!containerRef.current?.contains(document.activeElement) && document.activeElement !== document.body) {
        return;
      }
      const nodes = visibleNodes;
      const idx = selected ? nodes.findIndex((n) => n.path === selected) : -1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = nodes[Math.min(idx + 1, nodes.length - 1)];
        if (next) {
          setSelected(next.path);
          if (e.shiftKey && anchorRef.current) {
            const keys = nodes.map(keyOf);
            const a = keys.indexOf(anchorRef.current);
            const b = keys.indexOf(keyOf(next));
            if (a >= 0 && b >= 0) {
              const [lo, hi] = a < b ? [a, b] : [b, a];
              setMultiSelected(new Set(keys.slice(lo, hi + 1)));
            }
          } else {
            anchorRef.current = keyOf(next);
            setMultiSelected(new Set([keyOf(next)]));
          }
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = nodes[Math.max(idx - 1, 0)];
        if (prev) {
          setSelected(prev.path);
          if (e.shiftKey && anchorRef.current) {
            const keys = nodes.map(keyOf);
            const a = keys.indexOf(anchorRef.current);
            const b = keys.indexOf(keyOf(prev));
            if (a >= 0 && b >= 0) {
              const [lo, hi] = a < b ? [a, b] : [b, a];
              setMultiSelected(new Set(keys.slice(lo, hi + 1)));
            }
          } else {
            anchorRef.current = keyOf(prev);
            setMultiSelected(new Set([keyOf(prev)]));
          }
        }
      } else if (e.key === "ArrowRight") {
        const n = nodes[idx];
        if (n?.kind === "dir") {
          if (!expanded.has(n.path)) expand(n.path);
          else {
            const next = nodes[idx + 1];
            if (next) setSelected(next.path);
          }
          e.preventDefault();
        }
      } else if (e.key === "ArrowLeft") {
        const n = nodes[idx];
        if (!n) return;
        if (n.kind === "dir" && expanded.has(n.path)) {
          toggle(n.path);
        } else {
          const parent = parentOf(n.path);
          if (parent) setSelected(parent);
        }
        e.preventDefault();
      } else if (e.key === "Enter") {
        if (multiSelected.size > 1) {
          e.preventDefault();
          openSelected();
          return;
        }
        const n = nodes[idx];
        if (!n) return;
        if (n.kind === "dir") toggle(n.path);
        else handlers.onOpen(n);
      } else if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
        // Select-all *visible* entries (don't clobber browser find/replace
        // since Monaco owns that when focused — FileTree only reacts when
        // it has focus).
        e.preventDefault();
        setMultiSelected(new Set(nodes.map(keyOf)));
      } else if (e.key === "Escape") {
        setMultiSelected((prev) => (prev.size > 1 ? new Set() : prev));
      } else if (e.key === "F2") {
        const n = nodes[idx];
        if (n) beginRename(n);
      } else if ((e.key === "Delete" || e.key === "Backspace") && (e.metaKey || !e.metaKey)) {
        if (e.key === "Backspace" && !e.metaKey) return;
        const n = nodes[idx];
        if (n) void handleDelete(n);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleNodes, selected, expanded, renaming, creating, handlers, expand, toggle, multiSelected, openSelected]);

  const menuItems = (node: TreeNode | null): MenuEntry[] => {
    const defaultRootId = tree[0]?.rootId ?? "agent";
    if (!node) {
      return [
        {
          label: "New File",
          icon: <FilePlus size={14} />,
          onClick: () => beginCreate(defaultRootId, "", "file"),
        },
        {
          label: "New Folder",
          icon: <FolderPlus size={14} />,
          onClick: () => beginCreate(defaultRootId, "", "dir"),
        },
      ];
    }
    // Multi-select context menu: hides per-node ops (rename/create) that don't
    // make sense for a batch, and scopes actions to the whole selection.
    if (multiSelected.size > 1 && multiSelected.has(keyOf(node))) {
      const count = multiSelected.size;
      const fileCount = selectedNodes.filter((n) => n.kind === "file").length;
      return [
        ...(fileCount > 0
          ? [
              {
                label: `Open ${fileCount} file${fileCount === 1 ? "" : "s"}`,
                onClick: () => openSelected(),
              } as MenuEntry,
            ]
          : []),
        {
          label: "Copy Paths",
          onClick: () =>
            void navigator.clipboard.writeText(
              selectedNodes.map((n) => n.path).join("\n"),
            ),
        },
        { separator: true },
        {
          label: `Delete ${count} items`,
          shortcut: "⌫",
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () => void handleDelete(node),
        },
      ];
    }
    const parent = node.kind === "dir" ? node.path : parentOf(node.path);
    return [
      {
        label: "New File",
        icon: <FilePlus size={14} />,
        onClick: () => beginCreate(node.rootId, parent, "file"),
      },
      {
        label: "New Folder",
        icon: <FolderPlus size={14} />,
        onClick: () => beginCreate(node.rootId, parent, "dir"),
      },
      { separator: true },
      {
        label: node.kind === "file" ? "Open" : expanded.has(node.path) ? "Collapse" : "Expand",
        onClick: () => (node.kind === "file" ? handlers.onOpen(node) : toggle(node.path)),
      },
      {
        label: "Rename",
        shortcut: "F2",
        icon: <Pencil size={14} />,
        onClick: () => beginRename(node),
      },
      { separator: true },
      {
        label: "Copy Path",
        onClick: () => void navigator.clipboard.writeText(node.path),
      },
      {
        label: "Delete",
        shortcut: "⌫",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => void handleDelete(node),
      },
    ];
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="h-full outline-none overflow-auto"
      onContextMenu={(e) => {
        if (e.target === containerRef.current) openContextMenu(e, null);
      }}
      onClick={() => {
        setSelected(null);
        setMultiSelected(new Set());
      }}
    >
      {rows.map((row, i) => {
        if (row.kind === "new") {
          return (
            <InlineInput
              key={`new-${i}`}
              depth={row.depth}
              icon={
                row.mode === "dir" ? (
                  <Folder size={15} className="text-[color:var(--ide-accent-folder)]" />
                ) : (
                  <File size={15} className="text-[color:var(--ide-accent-file-icon)]" />
                )
              }
              value={creating?.draft ?? ""}
              onChange={(v) => setCreating((c) => (c ? { ...c, draft: v } : c))}
              onCommit={commitCreate}
              onCancel={() => setCreating(null)}
            />
          );
        }

        const { node, depth } = row;
        const isExpanded = node.kind === "dir" && expanded.has(node.path);
        const isActive = node.path === activePath;
        const isSelected = node.path === selected;
        const isMulti = multiSelected.has(keyOf(node));
        const isDropInto = dropTarget === node.path && node.kind === "dir";
        const ext = node.name.split(".").pop()?.toLowerCase() ?? "";

        if (renaming?.path === node.path) {
          return (
            <InlineInput
              key={node.path}
              depth={depth}
              icon={
                node.kind === "dir" ? (
                  <Folder size={15} className="text-[color:var(--ide-accent-folder)]" />
                ) : (
                  <File size={15} className={iconFor(ext)} />
                )
              }
              value={renaming.draft}
              onChange={(v) => setRenaming((r) => (r ? { ...r, draft: v } : r))}
              onCommit={commitRename}
              onCancel={() => setRenaming(null)}
            />
          );
        }

        const isWorkspaceRoot = (node as TreeNode).isRoot === true;

        return (
          <div
            key={`${node.rootId}::${node.path}`}
            draggable={!isWorkspaceRoot}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-ide-path", node.path);
              e.dataTransfer.setData("application/x-ide-root", node.rootId);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (node.kind !== "dir") return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(node.path);
            }}
            onDragLeave={() => setDropTarget((p) => (p === node.path ? null : p))}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              if (node.kind !== "dir") return;
              const src = e.dataTransfer.getData("application/x-ide-path");
              const srcRoot = e.dataTransfer.getData("application/x-ide-root");
              if (!src || src === node.path) return;
              if (srcRoot && srcRoot !== node.rootId) return;
              const srcNode = findNode(tree, src);
              if (srcNode) void handlers.onMove(srcNode, node);
            }}
            onClick={(e) => handleRowClick(e, node)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (node.kind === "file") handlers.onOpen(node);
            }}
            onContextMenu={(e) => openContextMenu(e, node)}
            className={
              isWorkspaceRoot
                ? `group flex cursor-pointer items-center gap-1 px-2 py-[4px] text-[11px] font-semibold uppercase tracking-wider min-w-0 ${
                    isDropInto
                      ? "bg-[color:var(--ide-active-bg)] text-white"
                      : "text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-hover)]"
                  }`
                : `group flex cursor-pointer items-center gap-1 px-2 py-[3px] text-[13px] min-w-0 ${
                    isDropInto
                      ? "bg-[color:var(--ide-active-bg)] ring-1 ring-inset ring-[color:var(--ide-active-ring)]"
                      : isMulti
                      ? "bg-[color:var(--ide-active)] text-[color:var(--ide-text-strong)]"
                      : isActive
                      ? "bg-[color:var(--ide-active)] text-[color:var(--ide-text-strong)]"
                      : isSelected
                      ? "bg-[color:var(--ide-hover)] text-[color:var(--ide-text-strong)]"
                      : "text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
                  }`
            }
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            {node.kind === "dir" ? (
              <>
                <ChevronRight
                  size={14}
                  className={`text-[color:var(--ide-muted)] transition-transform ${
                    isExpanded ? "rotate-90" : ""
                  }`}
                />
                {!isWorkspaceRoot &&
                  (isExpanded ? (
                    <FolderOpen size={15} className="text-[color:var(--ide-accent-folder)]" />
                  ) : (
                    <Folder size={15} className="text-[color:var(--ide-accent-folder)]" />
                  ))}
              </>
            ) : (
              <>
                <span className="w-[14px]" />
                <File size={15} className={iconFor(ext)} />
              </>
            )}
            <span className="truncate min-w-0 flex-1" title={node.path}>{node.name}</span>
          </div>
        );
      })}

      {/* empty area drop target (move to root) */}
      <div
        className="min-h-[40px]"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropTarget("__root__");
        }}
        onDragLeave={() => setDropTarget((p) => (p === "__root__" ? null : p))}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(null);
          const src = e.dataTransfer.getData("application/x-ide-path");
          if (!src) return;
          const srcNode = findNode(tree, src);
          if (srcNode && parentOf(src) !== "") void handlers.onMove(srcNode, null);
        }}
        onContextMenu={(e) => openContextMenu(e, null)}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function InlineInput({
  depth,
  icon,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  depth: number;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div
      className="flex items-center gap-1 bg-[color:var(--ide-bg)] px-2 py-[2px]"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="w-[14px]" />
      {icon}
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="no-focus-ring flex-1 min-w-0 bg-[color:var(--ide-input)] px-1 py-[1px] text-[13px] text-[color:var(--ide-text-strong)] outline outline-1 outline-[color:var(--ide-active-ring)]"
      />
    </div>
  );
}

function findNode(tree: TreeNode[], path: string): TreeNode | null {
  for (const n of tree) {
    if (n.path === path) return n;
    if (n.kind === "dir" && n.children) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}
