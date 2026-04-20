import { useState } from "react";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import type { TreeNode } from "./types";

function TreeItem({
  node,
  depth,
  activePath,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onOpen: (n: TreeNode) => void;
}) {
  const [open, setOpen] = useState(depth < 2);

  if (node.kind === "dir") {
    return (
      <>
        <button
          onClick={() => setOpen((o) => !o)}
          className="group flex w-full items-center gap-1 px-2 py-[3px] text-left text-[13px] text-[#cccccc] hover:bg-[#2a2d2e]"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <ChevronRight
            size={14}
            className={`text-[#858585] transition-transform ${open ? "rotate-90" : ""}`}
          />
          {open ? (
            <FolderOpen size={15} className="text-[#dcb67a]" />
          ) : (
            <Folder size={15} className="text-[#dcb67a]" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open &&
          node.children?.map((c) => (
            <TreeItem
              key={c.path}
              node={c}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
            />
          ))}
      </>
    );
  }

  const isActive = node.path === activePath;
  return (
    <button
      onClick={() => onOpen(node)}
      className={`flex w-full items-center gap-1 px-2 py-[3px] text-left text-[13px] ${
        isActive ? "bg-[#37373d] text-white" : "text-[#cccccc] hover:bg-[#2a2d2e]"
      }`}
      style={{ paddingLeft: 8 + depth * 12 + 14 }}
    >
      <File size={15} className="text-[#75beff]" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function FileTree({
  tree,
  activePath,
  onOpen,
}: {
  tree: TreeNode[];
  activePath: string | null;
  onOpen: (n: TreeNode) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[#858585]">
        Explorer
      </div>
      <div className="flex-1 overflow-auto py-1">
        {tree.map((n) => (
          <TreeItem
            key={n.path}
            node={n}
            depth={0}
            activePath={activePath}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}
