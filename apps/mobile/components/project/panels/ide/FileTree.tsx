import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Download,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Scissors,
  Copy as CopyIcon,
  ClipboardPaste,
  CopyPlus,
  Columns2,
  Search as SearchIcon,
  Trash2,
} from "lucide-react-native";
import type { TreeNode } from "./types";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { useGitStatusContext } from "./git/GitStatusContext";
import type { GitShortCode } from "./git/bridge";
import { computeDropZone } from "./file-tree-drop-zone";
import { buildCompactFolderChain } from "./explorer-compact-folders";
import { useDragAutoScroll } from "./useDragAutoScroll";
import { renameSelectionEnd, validateEntryName } from "./entry-name";

export interface FileTreeHandlers {
  /** `preview: true` = single-click open (replaceable tab); omitted = keep the tab. */
  onOpen: (node: TreeNode, opts?: { preview?: boolean }) => void;
  onCreate: (rootId: string, parentPath: string, name: string, kind: "file" | "dir") => Promise<void>;
  onRename: (node: TreeNode, newName: string) => Promise<void>;
  onDelete: (node: TreeNode) => Promise<void>;
  onMove: (from: TreeNode, toDir: TreeNode | null) => Promise<void>;
  /**
   * Download a file to the user's machine (web only). Wired to the workspace
   * service's authed blob fetch in Workbench; only offered for files.
   */
  onDownload: (node: TreeNode) => void | Promise<void>;
  /**
   * Fetch the children of a directory whose `lazy` flag was set by the
   * server (e.g. `node_modules`, `dist`). The handler is expected to splice
   * the loaded children into the tree so the next render shows them under
   * the directory. Rejects on error; the FileTree surfaces it inline with
   * a retry affordance.
   */
  onLoadSubtree?: (rootId: string, path: string) => Promise<void>;
  /** Copy `from` into `toDirPath` of `toRootId` under `newName` (Paste / Duplicate). */
  onCopy?: (from: TreeNode, toRootId: string, toDirPath: string, newName: string) => Promise<void>;
  /** Open a file in a new editor group beside the active one. */
  onOpenToSide?: (node: TreeNode) => void;
  /** Open the Search view restricted to a folder ("Find in Folder…"). */
  onFindInFolder?: (node: TreeNode) => void;
  /** Absolute filesystem path for "Copy Path" (null when unknown, e.g. cloud). */
  absolutePath?: (node: TreeNode) => string | null;
}

type FlatRow =
  | { kind: "node"; node: TreeNode; depth: number; parentPath: string; compactLabel?: string }
  | { kind: "new"; depth: number; parentPath: string; mode: "file" | "dir" }
  // Synthetic rows rendered beneath an expanded lazy directory whose
  // children haven't materialised yet (loading) or whose fetch failed
  // (error, with a Retry button). Carries the parent node so the retry
  // handler can re-invoke `onLoadSubtree`.
  | { kind: "lazy-loading"; depth: number; parent: TreeNode }
  | { kind: "lazy-error"; depth: number; parent: TreeNode; message: string }
  | { kind: "lazy-empty"; depth: number; parent: TreeNode };

function flatten(
  tree: TreeNode[],
  expanded: Set<string>,
  loadingLazy: Set<string>,
  lazyErrors: Map<string, string>,
  depth = 0,
  parentPath = "",
  out: FlatRow[] = [],
): FlatRow[] {
  for (const original of tree) {
    const compact = buildCompactFolderChain(original);
    const n = compact.node;
    out.push({
      kind: "node",
      node: n,
      depth,
      parentPath,
      compactLabel: compact.compacted ? compact.label : undefined,
    });
    if (n.kind === "dir" && expanded.has(n.path)) {
      if (n.children && n.children.length > 0) {
        flatten(n.children, expanded, loadingLazy, lazyErrors, depth + 1, n.path, out);
      } else if (n.lazy) {
        const k = keyOf(n);
        const err = lazyErrors.get(k);
        if (err) out.push({ kind: "lazy-error", depth: depth + 1, parent: n, message: err });
        else if (loadingLazy.has(k)) out.push({ kind: "lazy-loading", depth: depth + 1, parent: n });
        else out.push({ kind: "lazy-empty", depth: depth + 1, parent: n });
      } else if (n.children) {
        // A loaded folder with nothing in it: say so instead of showing a
        // chevron that opens onto nothing.
        out.push({ kind: "lazy-empty", depth: depth + 1, parent: n });
      }
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

/** Folder node for (rootId, path); path "" is the root row itself. */
function findDirNode(tree: TreeNode[], rootId: string, path: string): TreeNode | null {
  for (const r of tree) {
    if (r.rootId !== rootId) continue;
    if (path === "" && r.isRoot) return r;
    const hit = findNode(r.children ?? [], path);
    if (hit && hit.kind === "dir") return hit;
  }
  return null;
}

/**
 * "name copy.ext", "name copy 2.ext", … — the first name not in `taken`
 * (case-insensitive). Dotfiles (`.env`) keep their whole name as the stem.
 */
export function uniqueCopyName(name: string, kind: "file" | "dir", taken: Set<string>): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const dot = kind === "file" ? name.lastIndexOf(".") : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} copy${i === 1 ? "" : ` ${i}`}${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} copy ${Date.now()}${ext}`;
}

export function FileTree({
  tree,
  activePath,
  handlers,
  newRequest,
  revealRequest,
  collapseRequest,
}: {
  tree: TreeNode[];
  activePath: string | null;
  handlers: FileTreeHandlers;
  /** Explicit "Reveal in Explorer" (works even when the file is already active). */
  revealRequest?: { path: string; nonce: number } | null;
  /** "Collapse Folders in Explorer" — bump `nonce` to collapse everything. */
  collapseRequest?: { nonce: number } | null;
  newRequest?: { kind: "file" | "dir"; nonce: number; rootId?: string } | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const n of tree) if (n.kind === "dir") s.add(n.path);
    return s;
  });
  // Lazy-load state for `node_modules`/`dist`/etc. Keyed by `rootId::path` so
  // two roots with a same-named lazy dir don't share state. `loadingLazy`
  // tracks in-flight fetches (rendered as a spinner row), `lazyErrors`
  // captures failures (rendered as an error row with Retry).
  const [loadingLazy, setLoadingLazy] = useState<Set<string>>(new Set());
  const [lazyErrors, setLazyErrors] = useState<Map<string, string>>(new Map());
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
  /** Explorer clipboard (Cut / Copy → Paste). Internal to the tree. */
  const [clipboard, setClipboard] = useState<{ nodes: TreeNode[]; mode: "copy" | "cut" } | null>(null);
  const cutKeys = useMemo(
    () => (clipboard?.mode === "cut" ? new Set(clipboard.nodes.map(keyOf)) : null),
    [clipboard],
  );
  const [treeFocused, setTreeFocused] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // BUG-002: edge auto-scroll + scrollTop-correct drop zone math.
  // The hook owns the rAF loop; pure math lives in computeDropZone.
  const autoScroll = useDragAutoScroll(containerRef);
  // Track whether a drag is currently in progress over the tree, so
  // the scroll listener can clear stale dropTarget highlights. Without
  // this, manually scrolling during a drag leaves the previously-
  // hovered folder visually marked even after the pointer no longer
  // sits over it (the drop highlight is set by per-row onDragOver and
  // wouldn't fire again until the next pointer move).
  const dragActiveRef = useRef(false);
  const git = useGitStatusContext();

  const rows = useMemo(() => {
    const base = flatten(tree, expanded, loadingLazy, lazyErrors);
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
  }, [tree, expanded, loadingLazy, lazyErrors, creating]);

  const visibleRows = useMemo(
    () => rows.filter((r): r is Extract<FlatRow, { kind: "node" }> => r.kind === "node"),
    [rows],
  );

  /** Linear view of *visible* nodes used by keyboard nav and range selection. */
  const visibleNodes = useMemo(
    () => visibleRows.map((r) => r.node),
    [visibleRows],
  );

  /** Names of the entries inside `parentPath` of `rootId` (for collision checks). */
  const siblingNames = useCallback(
    (rootId: string, parentPath: string): string[] =>
      visibleNodes
        .filter((n) => n.path !== "" && n.rootId === rootId && parentOf(n.path) === parentPath)
        .map((n) => n.name),
    [visibleNodes],
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

  /**
   * Fetch the children of a lazy directory. Idempotent: if a load is already
   * in flight for this node, do nothing. Clears any prior error before the
   * attempt so the spinner takes over from the error row. The success path
   * does NOT clear the loading flag explicitly — once the parent splices in
   * children, `node.lazy` becomes undefined and the synthetic row stops
   * rendering. The loading flag is dropped here on the catch / finally edge.
   */
  const loadLazy = useCallback(
    async (node: TreeNode) => {
      if (!handlers.onLoadSubtree) return;
      const k = keyOf(node);
      if (loadingLazy.has(k)) return;
      setLoadingLazy((prev) => {
        const next = new Set(prev);
        next.add(k);
        return next;
      });
      setLazyErrors((prev) => {
        if (!prev.has(k)) return prev;
        const next = new Map(prev);
        next.delete(k);
        return next;
      });
      try {
        await handlers.onLoadSubtree(node.rootId, node.path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLazyErrors((prev) => {
          const next = new Map(prev);
          next.set(k, msg);
          return next;
        });
      } finally {
        setLoadingLazy((prev) => {
          if (!prev.has(k)) return prev;
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
      }
    },
    [handlers, loadingLazy],
  );

  /**
   * Click-handler for directory rows. Always toggles expand state so the
   * arrow rotates immediately; additionally kicks off a lazy fetch the first
   * time a `lazy` dir without children is opened. Repeated expand/collapse
   * after a successful load is just an `expanded` set tweak — no new RPCs.
   */
  const toggleDir = useCallback(
    (node: TreeNode) => {
      toggle(node.path);
      const wasExpanded = expanded.has(node.path);
      if (
        !wasExpanded &&
        node.lazy &&
        (!node.children || node.children.length === 0) &&
        !lazyErrors.has(keyOf(node))
      ) {
        void loadLazy(node);
      }
    },
    [toggle, expanded, lazyErrors, loadLazy],
  );

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

  /** Expand every ancestor of `path` so its row is rendered. */
  const expandAncestors = useCallback((path: string) => {
    setExpanded((prev) => {
      let next: Set<string> | null = null;
      for (let p = parentOf(path); p; p = parentOf(p)) {
        if (!prev.has(p)) (next ??= new Set(prev)).add(p);
      }
      return next ?? prev;
    });
  }, []);

  const scrollRowIntoView = useCallback((path: string) => {
    if (typeof requestAnimationFrame === "undefined") return;
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector(
        `[data-tree-path="${path.replace(/["\\]/g, "\\$&")}"]`,
      ) as HTMLElement | null;
      el?.scrollIntoView?.({ block: "nearest" });
    });
  }, []);

  // VS Code `explorer.autoReveal`: when the active editor changes (new file,
  // tab switch, Cmd+P, search result, agent opens a file), expand its parents,
  // select it and scroll it into view so the tree always shows "where am I".
  const lastRevealedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activePath || lastRevealedRef.current === activePath) return;
    lastRevealedRef.current = activePath;
    expandAncestors(activePath);
    setSelected(activePath);
    setMultiSelected(new Set());
    scrollRowIntoView(activePath);
  }, [activePath, expandAncestors, scrollRowIntoView]);

  const lastRevealNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!revealRequest || lastRevealNonceRef.current === revealRequest.nonce) return;
    lastRevealNonceRef.current = revealRequest.nonce;
    expandAncestors(revealRequest.path);
    setSelected(revealRequest.path);
    setMultiSelected(new Set());
    scrollRowIntoView(revealRequest.path);
  }, [revealRequest, expandAncestors, scrollRowIntoView]);

  const lastCollapseNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!collapseRequest || lastCollapseNonce.current === collapseRequest.nonce) return;
    lastCollapseNonce.current = collapseRequest.nonce;
    // Keep the workspace roots open (they're headers, not folders).
    const next = new Set<string>();
    for (const n of tree) if (n.isRoot) next.add(n.path);
    setExpanded(next);
  }, [collapseRequest, tree]);

  /** Names already used inside a folder (for collision-free paste/duplicate). */
  const namesIn = useCallback(
    (rootId: string, dirPath: string): Set<string> =>
      new Set((findDirNode(tree, rootId, dirPath)?.children ?? []).map((c) => c.name)),
    [tree],
  );

  /** Folder a paste/duplicate should land in for `node` (itself if a folder). */
  const dropDirFor = useCallback(
    (node: TreeNode | null): { rootId: string; path: string } => {
      if (!node) {
        const r = tree[0];
        return { rootId: r?.rootId ?? "agent", path: "" };
      }
      return { rootId: node.rootId, path: node.kind === "dir" ? node.path : parentOf(node.path) };
    },
    [tree],
  );

  const copyToClipboard = useCallback(
    (nodes: TreeNode[], mode: "copy" | "cut") => {
      const usable = nodes.filter((n) => !n.isRoot);
      if (usable.length === 0) return;
      setClipboard({ nodes: usable, mode });
      // Also expose the paths to the OS clipboard so they paste into chat/terminal.
      void navigator.clipboard?.writeText(usable.map((n) => n.path).join("\n")).catch(() => {});
    },
    [],
  );

  const pasteInto = useCallback(
    async (target: TreeNode | null) => {
      if (!clipboard) return;
      const dest = dropDirFor(target);
      const taken = namesIn(dest.rootId, dest.path);
      const destNode = findDirNode(tree, dest.rootId, dest.path);
      if (dest.path) expand(dest.path);
      for (const src of clipboard.nodes) {
        try {
          if (clipboard.mode === "cut") {
            if (destNode) await handlers.onMove(src, destNode);
          } else if (handlers.onCopy) {
            const name = uniqueCopyName(src.name, src.kind, taken);
            taken.add(name);
            await handlers.onCopy(src, dest.rootId, dest.path, name);
          }
        } catch {
          /* toast handled by parent */
        }
      }
      if (clipboard.mode === "cut") setClipboard(null);
    },
    [clipboard, dropDirFor, namesIn, tree, expand, handlers],
  );

  const duplicateNode = useCallback(
    async (node: TreeNode) => {
      if (node.isRoot || !handlers.onCopy) return;
      const parent = parentOf(node.path);
      const name = uniqueCopyName(node.name, node.kind, namesIn(node.rootId, parent));
      try {
        await handlers.onCopy(node, node.rootId, parent, name);
      } catch {
        /* toast handled by parent */
      }
    },
    [handlers, namesIn],
  );

  const commitCreate = async () => {
    if (!creating) return;
    const name = creating.draft.trim();
    const { rootId, parentPath, kind } = creating;
    setCreating(null);
    if (!name) return;
    try {
      await handlers.onCreate(rootId, parentPath, name, kind);
      // New folders aren't opened in an editor, so reveal/select them here
      // (new files get revealed through the active-editor effect above).
      if (kind === "dir") {
        const full = parentPath ? `${parentPath}/${name}` : name;
        expandAncestors(full);
        setSelected(full);
        scrollRowIntoView(full);
      }
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
      if (node.kind === "dir") toggleDir(node);
      else handlers.onOpen(node, { preview: true });
    },
    [visibleNodes, toggleDir, handlers],
  );

  // Type-to-jump buffer (VS Code "type to navigate"): typing letters quickly
  // jumps to the next visible row whose name starts with what was typed.
  const typeBufRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (renaming || creating) return;
      const insideTree = !!containerRef.current?.contains(document.activeElement);
      if (!insideTree && document.activeElement !== document.body) {
        return;
      }
      const nodes = visibleNodes;
      const idx = selected ? nodes.findIndex((n) => n.path === selected) : -1;
      const mod = e.metaKey || e.ctrlKey;

      /** Select `next` (optionally extending the range) and keep it in view. */
      const goTo = (next: TreeNode | undefined, extend: boolean) => {
        if (!next) return;
        setSelected(next.path);
        if (extend && anchorRef.current) {
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
        scrollRowIntoView(next.path);
      };
      const pageSize = Math.max(
        1,
        Math.floor((containerRef.current?.clientHeight ?? 400) / 24) - 1,
      );

      if (e.key === "ArrowDown") {
        e.preventDefault();
        goTo(nodes[Math.min(idx + 1, nodes.length - 1)], e.shiftKey);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        goTo(nodes[Math.max(idx - 1, 0)], e.shiftKey);
      } else if (e.key === "Home" && insideTree) {
        e.preventDefault();
        goTo(nodes[0], e.shiftKey);
      } else if (e.key === "End" && insideTree) {
        e.preventDefault();
        goTo(nodes[nodes.length - 1], e.shiftKey);
      } else if (e.key === "PageDown" && insideTree) {
        e.preventDefault();
        goTo(nodes[Math.min(Math.max(idx, 0) + pageSize, nodes.length - 1)], e.shiftKey);
      } else if (e.key === "PageUp" && insideTree) {
        e.preventDefault();
        goTo(nodes[Math.max(idx - pageSize, 0)], e.shiftKey);
      } else if (e.key === "ArrowRight") {
        const n = nodes[idx];
        if (n?.kind === "dir") {
          if (!expanded.has(n.path)) {
            // Expand-via-arrow on a lazy dir triggers the fetch too.
            toggleDir(n);
          } else {
            goTo(nodes[idx + 1], false);
          }
          e.preventDefault();
        }
      } else if (e.key === "ArrowLeft") {
        const n = nodes[idx];
        const row = visibleRows[idx];
        if (!n || !row) return;
        if (n.kind === "dir" && expanded.has(n.path) && !n.isRoot) {
          toggle(n.path);
        } else {
          for (let i = idx - 1; i >= 0; i--) {
            const candidate = visibleRows[i];
            if (candidate.depth < row.depth) {
              goTo(candidate.node, false);
              break;
            }
          }
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
        // ⌘/Ctrl+Enter opens beside (VS Code: Ctrl+Enter).
        if (mod && n.kind === "file" && handlers.onOpenToSide) {
          e.preventDefault();
          handlers.onOpenToSide(n);
          return;
        }
        if (n.kind === "dir") toggleDir(n);
        else handlers.onOpen(n);
      } else if (e.key === "a" && mod) {
        // Select-all *visible* entries (don't clobber browser find/replace
        // since Monaco owns that when focused — FileTree only reacts when
        // it has focus).
        if (!insideTree) return;
        e.preventDefault();
        setMultiSelected(new Set(nodes.map(keyOf)));
      } else if ((e.key === "c" || e.key === "x") && mod && !e.shiftKey && !e.altKey && insideTree) {
        const targets = multiSelected.size > 0 ? selectedNodes : nodes[idx] ? [nodes[idx]] : [];
        if (targets.length === 0) return;
        e.preventDefault();
        copyToClipboard(targets, e.key === "c" ? "copy" : "cut");
      } else if (e.key === "v" && mod && !e.shiftKey && !e.altKey && insideTree) {
        if (!clipboard) return;
        e.preventDefault();
        void pasteInto(nodes[idx] ?? null);
      } else if (e.key === "Escape") {
        if (!insideTree) return;
        if (clipboard?.mode === "cut") setClipboard(null);
        setSelected(null);
        setMultiSelected((prev) => (prev.size > 0 ? new Set() : prev));
      } else if (e.key === "F2") {
        const n = nodes[idx];
        if (n && !n.isRoot) beginRename(n);
      } else if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) {
        const n = nodes[idx];
        if (n && !n.isRoot) void handleDelete(n);
      } else if (
        insideTree &&
        !mod &&
        !e.altKey &&
        e.key.length === 1 &&
        e.key !== " " &&
        nodes.length > 0
      ) {
        const now = Date.now();
        const buf = typeBufRef.current;
        const text = (now - buf.at > 700 ? "" : buf.text) + e.key.toLowerCase();
        typeBufRef.current = { text, at: now };
        // Repeating one letter cycles through matches; otherwise search from
        // the current row (inclusive) so refining the prefix stays put.
        const cycle = text.length > 1 && text.split("").every((ch) => ch === text[0]);
        const needle = cycle ? text[0] : text;
        const startAt = idx < 0 ? 0 : cycle ? idx + 1 : idx;
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[(startAt + i) % nodes.length];
          if (!n.isRoot && n.name.toLowerCase().startsWith(needle)) {
            e.preventDefault();
            goTo(n, false);
            break;
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleNodes, visibleRows, selected, expanded, renaming, creating, handlers, expand, toggle, toggleDir, multiSelected, openSelected, selectedNodes, clipboard, copyToClipboard, pasteInto, scrollRowIntoView]);

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
          label: "Cut",
          shortcut: "⌘X",
          icon: <Scissors size={14} />,
          onClick: () => copyToClipboard(selectedNodes, "cut"),
        },
        {
          label: "Copy",
          shortcut: "⌘C",
          icon: <CopyIcon size={14} />,
          onClick: () => copyToClipboard(selectedNodes, "copy"),
        },
        { separator: true },
        ...(handlers.absolutePath
          ? [
              {
                label: "Copy Paths",
                onClick: () =>
                  void navigator.clipboard.writeText(
                    selectedNodes.map((n) => handlers.absolutePath?.(n) ?? n.path).join("\n"),
                  ),
              } as MenuEntry,
            ]
          : []),
        {
          label: "Copy Relative Paths",
          onClick: () =>
            void navigator.clipboard.writeText(
              selectedNodes.map((n) => n.path).join("\n"),
            ),
        },
        ...(fileCount > 0
          ? [
              {
                label: `Download ${fileCount} file${fileCount === 1 ? "" : "s"}`,
                icon: <Download size={14} />,
                onClick: () => {
                  for (const n of selectedNodes) {
                    if (n.kind === "file") void handlers.onDownload(n);
                  }
                },
              } as MenuEntry,
            ]
          : []),
        { separator: true },
        {
          label: `Delete ${count} items`,
          shortcut: "⌘⌫",
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () => void handleDelete(node),
        },
      ];
    }
    const parent = node.kind === "dir" ? node.path : parentOf(node.path);
    const abs = handlers.absolutePath?.(node) ?? null;
    const canPaste = !!clipboard && (clipboard.mode === "cut" || !!handlers.onCopy);
    const creation: MenuEntry[] = [
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
    ];
    const findInFolder: MenuEntry[] =
      node.kind === "dir" && handlers.onFindInFolder
        ? [
            {
              label: "Find in Folder…",
              icon: <SearchIcon size={14} />,
              onClick: () => handlers.onFindInFolder?.(node),
            },
          ]
        : [];
    // Workspace roots are headers: no rename / delete / cut / duplicate.
    if (node.isRoot) {
      return [
        ...creation,
        ...findInFolder,
        {
          label: "Paste",
          shortcut: "⌘V",
          icon: <ClipboardPaste size={14} />,
          disabled: !canPaste,
          onClick: () => void pasteInto(node),
        },
        { separator: true },
        ...(abs
          ? [{ label: "Copy Path", onClick: () => void navigator.clipboard.writeText(abs) } as MenuEntry]
          : []),
      ];
    }
    return [
      ...creation,
      {
        label: node.kind === "file" ? "Open" : expanded.has(node.path) ? "Collapse" : "Expand",
        onClick: () => (node.kind === "file" ? handlers.onOpen(node) : toggleDir(node)),
      },
      ...(node.kind === "file" && handlers.onOpenToSide
        ? [
            {
              label: "Open to the Side",
              shortcut: "⌘↵",
              icon: <Columns2 size={14} />,
              onClick: () => handlers.onOpenToSide?.(node),
            } as MenuEntry,
          ]
        : []),
      ...findInFolder,
      { separator: true },
      {
        label: "Cut",
        shortcut: "⌘X",
        icon: <Scissors size={14} />,
        onClick: () => copyToClipboard([node], "cut"),
      },
      {
        label: "Copy",
        shortcut: "⌘C",
        icon: <CopyIcon size={14} />,
        onClick: () => copyToClipboard([node], "copy"),
      },
      {
        label: "Paste",
        shortcut: "⌘V",
        icon: <ClipboardPaste size={14} />,
        disabled: !canPaste,
        onClick: () => void pasteInto(node),
      },
      ...(handlers.onCopy
        ? [
            {
              label: "Duplicate",
              icon: <CopyPlus size={14} />,
              onClick: () => void duplicateNode(node),
            } as MenuEntry,
          ]
        : []),
      { separator: true },
      ...(abs
        ? [{ label: "Copy Path", onClick: () => void navigator.clipboard.writeText(abs) } as MenuEntry]
        : []),
      {
        label: abs ? "Copy Relative Path" : "Copy Path",
        onClick: () => void navigator.clipboard.writeText(node.path),
      },
      { separator: true },
      {
        label: "Rename",
        shortcut: "F2",
        icon: <Pencil size={14} />,
        onClick: () => beginRename(node),
      },
      ...(node.kind === "file"
        ? [
            {
              label: "Download",
              icon: <Download size={14} />,
              onClick: () => void handlers.onDownload(node),
            } as MenuEntry,
          ]
        : []),
      {
        label: "Delete",
        shortcut: "⌘⌫",
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
      role="tree"
      aria-label="Explorer"
      aria-multiselectable
      onFocus={() => setTreeFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTreeFocused(false);
      }}
      className="h-full outline-none overflow-auto"
      onContextMenu={(e) => {
        if (e.target === containerRef.current) openContextMenu(e, null);
      }}
      onClick={() => {
        setSelected(null);
        setMultiSelected(new Set());
      }}
      // BUG-002: container-level dragOver drives the auto-scroll loop using
      // scrollTop-corrected coordinates. Per-row handlers below still set
      // the drop target (the browser already resolves which row is under
      // the pointer), but the container is the only element that can
      // observe the pointer when the user has reached the edge band.
      onDragOver={(e) => {
        dragActiveRef.current = true;
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const { scrollDelta } = computeDropZone({
          clientY: e.clientY,
          containerRect: { top: rect.top, bottom: rect.bottom, height: rect.height },
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
        });
        autoScroll.updateDelta(scrollDelta);
      }}
      onDragLeave={(e) => {
        // Browser fires dragLeave on every child cross-over; only act when
        // the pointer truly leaves the container (relatedTarget outside).
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        dragActiveRef.current = false;
        autoScroll.stop();
      }}
      onDrop={() => {
        dragActiveRef.current = false;
        autoScroll.stop();
      }}
      onDragEnd={() => {
        // Fires on the source element regardless of where the drop landed,
        // including drops that escaped the container — canonical stop signal.
        dragActiveRef.current = false;
        autoScroll.stop();
      }}
      onScroll={() => {
        // BUG-002 follow-on: if the user manually scrolls during a drag, the
        // last-set dropTarget refers to a row that may no longer be under
        // the pointer. Clear it so the next onDragOver can re-resolve from
        // the freshly-laid-out DOM, avoiding a stale highlight.
        if (dragActiveRef.current) setDropTarget(null);
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
              validate={(v) =>
                validateEntryName(v, {
                  siblings: siblingNames(creating?.rootId ?? "", creating?.parentPath ?? ""),
                })
              }
            />
          );
        }

        if (row.kind === "lazy-loading") {
          return (
            <div
              key={`lazy-loading-${row.parent.rootId}::${row.parent.path}`}
              className="flex items-center gap-1 px-2 py-[3px] text-[12px] text-[color:var(--ide-muted)] italic"
              style={{ paddingLeft: 8 + row.depth * 12 }}
            >
              <Loader2 size={13} className="animate-spin" />
              <span>Loading…</span>
            </div>
          );
        }

        if (row.kind === "lazy-empty") {
          return (
            <div
              key={`lazy-empty-${row.parent.rootId}::${row.parent.path}`}
              className="flex items-center gap-1 px-2 py-[3px] text-[12px] text-[color:var(--ide-muted)] italic"
              style={{ paddingLeft: 8 + row.depth * 12 }}
            >
              <span>(empty)</span>
            </div>
          );
        }

        if (row.kind === "lazy-error") {
          const parent = row.parent;
          return (
            <div
              key={`lazy-error-${parent.rootId}::${parent.path}`}
              className="flex items-center gap-2 px-2 py-[3px] text-[12px] text-[color:var(--ide-error)]"
              style={{ paddingLeft: 8 + row.depth * 12 }}
              title={row.message}
            >
              <span className="truncate min-w-0 flex-1">Failed to load: {row.message}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void loadLazy(parent);
                }}
                className="flex items-center gap-1 rounded px-1 py-[1px] text-[11px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
              >
                <RefreshCw size={11} /> Retry
              </button>
            </div>
          );
        }

        const { node, depth } = row;
        const displayName = row.compactLabel ?? node.name;
        const isExpanded = node.kind === "dir" && expanded.has(node.path);
        const isActive = node.path === activePath;
        const isSelected = node.path === selected && !node.isRoot;
        const isMulti = multiSelected.has(keyOf(node));
        const isCut = cutKeys?.has(keyOf(node)) ?? false;
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
              selectEnd={renameSelectionEnd(node.name, node.kind === "dir")}
              validate={(v) =>
                validateEntryName(v, {
                  siblings: siblingNames(node.rootId, parentOf(node.path)),
                  currentName: node.name,
                })
              }
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
            data-tree-path={node.path}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={isSelected || isMulti}
            aria-expanded={node.kind === "dir" ? isExpanded : undefined}
            className={
              isWorkspaceRoot
                ? `group relative flex cursor-pointer items-center gap-1 px-2 py-[4px] text-[11px] font-semibold uppercase tracking-wider min-w-0 ${
                    isDropInto
                      ? "bg-[color:var(--ide-active-bg)] text-white"
                      : "text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-hover)]"
                  }`
                : `group relative flex cursor-pointer items-center gap-1 px-2 py-[3px] text-[13px] min-w-0 ${
                    isDropInto
                      ? "bg-[color:var(--ide-active-bg)] ring-1 ring-inset ring-[color:var(--ide-active-ring)]"
                      : (isMulti || isSelected) && treeFocused
                      ? "bg-[color:var(--ide-active)] text-[color:var(--ide-text-strong)] ring-1 ring-inset ring-[color:var(--ide-active-ring)]"
                      : isActive
                      ? "bg-[color:var(--ide-active)] text-[color:var(--ide-text-strong)]"
                      : isMulti || isSelected
                      ? "bg-[color:var(--ide-hover)] text-[color:var(--ide-text-strong)]"
                      : "text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
                  }${node.ignored ? " opacity-[0.55]" : ""}${isCut ? " opacity-50" : ""}`
            }
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            {!isWorkspaceRoot &&
              depth > 1 &&
              Array.from({ length: depth - 1 }, (_, g) => (
                <span
                  key={g}
                  aria-hidden
                  className="pointer-events-none absolute bottom-0 top-0 w-px bg-[color:var(--ide-border)] opacity-70"
                  style={{ left: 8 + (g + 1) * 12 + 7 }}
                />
              ))}
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
            <span className="truncate min-w-0 flex-1" title={node.ignored ? `${node.path} (ignored by .gitignore)` : node.path}>{displayName}</span>
            <GitStatusBadge code={node.kind === "dir" ? (git.folderDirty(node.path) ? "·" : null) : git.getStatus(node.path)} isFolderDirty={node.kind === "dir" && git.folderDirty(node.path)} />
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
  validate,
  selectEnd,
}: {
  depth: number;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Returns an error message for an invalid name, or null. */
  validate?: (v: string) => string | null;
  /** Offset to end the initial selection at (rename leaves the extension out). */
  selectEnd?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Commit/cancel must fire at most once. Escape unmounts the input, and the
  // resulting blur used to run `onCommit` with the stale draft — so Escape
  // saved the rename it was meant to abort.
  const doneRef = useRef(false);
  const error = validate ? validate(value) : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectEnd !== undefined) el.setSelectionRange(0, selectEnd);
    else el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (kind: "commit" | "cancel") => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (kind === "commit") onCommit();
    else onCancel();
  };

  return (
    <div
      className="relative flex items-center gap-1 bg-[color:var(--ide-bg)] px-2 py-[2px]"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="w-[14px]" />
      {icon}
      <input
        ref={ref}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        // Losing focus commits a valid name (VS Code behaviour) but never an
        // invalid one — that is treated as a cancel.
        onBlur={() => finish(error ? "cancel" : "commit")}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // Keep the input open so the user can fix the name.
            if (error) return;
            finish("commit");
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish("cancel");
          }
        }}
        className={`no-focus-ring flex-1 min-w-0 bg-[color:var(--ide-input)] px-1 py-[1px] text-[13px] text-[color:var(--ide-text-strong)] outline outline-1 ${
          error ? "outline-red-500" : "outline-[color:var(--ide-active-ring)]"
        }`}
      />
      {error && (
        <div
          role="alert"
          className="absolute left-0 right-0 top-full z-20 mx-2 rounded-sm border border-red-500 bg-[color:var(--ide-panel)] px-2 py-1 text-[11px] text-red-400 shadow-lg"
        >
          {error}
        </div>
      )}
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

/**
 * Single-letter status badge rendered at the right edge of every file row.
 * Color matches VS Code Dark+ conventions: M orange, A/U green, D/conflict red.
 * Renders nothing for clean files (returns null to skip the DOM node entirely).
 */
function GitStatusBadge({
  code,
  isFolderDirty,
}: {
  code: GitShortCode | null;
  isFolderDirty: boolean;
}) {
  if (!code && !isFolderDirty) return null;
  if (isFolderDirty && !code) {
    return (
      <span
        className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[#e2c08d]"
        title="Folder contains modified files"
      />
    );
  }
  const color =
    code === "M" || code === "T"
      ? "text-[#e2c08d]"
      : code === "A" || code === "?"
      ? "text-[#73c991]"
      : code === "D" || code === "U"
      ? "text-[color:var(--ide-error)]"
      : code === "R" || code === "C"
      ? "text-[#7aa6ff]"
      : "text-[color:var(--ide-muted)]";
  return (
    <span
      className={`ml-1 inline-block text-[11px] font-semibold tabular-nums ${color}`}
      title={statusTooltip(code!)}
    >
      {code}
    </span>
  );
}

function statusTooltip(c: GitShortCode): string {
  switch (c) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "T":
      return "Type changed";
    case "U":
      return "Unmerged (conflict)";
    case "?":
      return "Untracked";
    case "!":
      return "Ignored";
    default:
      return "Modified";
  }
}
