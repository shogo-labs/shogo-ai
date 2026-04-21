/**
 * AgentEditBanner — shown at the top of the editor area when the chat
 * agent wrote to a file that has local unsaved edits. Offers a choice
 * between accepting the agent's version or keeping the user's edits.
 *
 * Only the banner for the currently-active file is shown; other stashed
 * conflicts stay queued and surface as the user switches tabs. A count
 * pill indicates how many other files are also in conflict.
 */

import { FileWarning, RotateCw, X } from "lucide-react-native";

import type { LiveConflict } from "./useLiveAgentEdits";

export function AgentEditBanner({
  conflicts,
  activeFileId,
  onReload,
  onKeepMine,
}: {
  conflicts: LiveConflict[];
  activeFileId: string | null;
  onReload: (fileId: string) => void;
  onKeepMine: (fileId: string) => void;
}) {
  const current = activeFileId
    ? conflicts.find((c) => c.fileId === activeFileId)
    : null;
  if (!current) return null;

  const othersCount = conflicts.length - 1;

  return (
    <div className="flex items-center gap-3 border-b border-[#f9826c]/60 bg-[#f9826c]/15 px-3 py-1.5 text-[12px] text-[#f9d7cf]">
      <FileWarning size={14} className="shrink-0" />
      <span className="flex-1 truncate">
        Agent edited{" "}
        <span className="font-medium text-white">{current.path}</span>{" "}
        while you had unsaved changes.
        {othersCount > 0 && (
          <span className="ml-2 rounded bg-[#f9826c]/30 px-1.5 py-[1px] text-[11px] text-[#f9d7cf]">
            +{othersCount} more file{othersCount === 1 ? "" : "s"}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => onReload(current.fileId)}
        className="flex items-center gap-1 rounded bg-[#0e639c] px-2 py-0.5 text-white hover:bg-[#1177bb]"
        title="Discard your changes and load the agent's version"
      >
        <RotateCw size={12} />
        Load agent's version
      </button>
      <button
        type="button"
        onClick={() => onKeepMine(current.fileId)}
        className="flex items-center gap-1 rounded bg-[#3a3d41] px-2 py-0.5 text-[#cccccc] hover:bg-[#4a4d51]"
        title="Keep your unsaved edits; ignore the agent's write"
      >
        <X size={12} />
        Keep mine
      </button>
    </div>
  );
}
