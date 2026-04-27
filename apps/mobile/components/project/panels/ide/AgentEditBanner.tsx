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
    <div className="flex items-center gap-3 border-b border-[color:var(--ide-conflict-border)] bg-[color:var(--ide-conflict-bg)] px-3 py-1.5 text-[12px] text-[color:var(--ide-conflict-text)]">
      <FileWarning size={14} className="shrink-0" />
      <span className="flex-1 truncate">
        Agent edited{" "}
        <span className="font-medium text-[color:var(--ide-text-strong)]">{current.path}</span>{" "}
        while you had unsaved changes.
        {othersCount > 0 && (
          <span className="ml-2 rounded bg-[color:var(--ide-conflict-pill-bg)] px-1.5 py-[1px] text-[11px]">
            +{othersCount} more file{othersCount === 1 ? "" : "s"}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => onReload(current.fileId)}
        className="flex items-center gap-1 rounded bg-[color:var(--ide-btn-primary-bg)] px-2 py-0.5 text-white hover:bg-[color:var(--ide-btn-primary-hover)]"
        title="Discard your changes and load the agent's version"
      >
        <RotateCw size={12} />
        Load agent's version
      </button>
      <button
        type="button"
        onClick={() => onKeepMine(current.fileId)}
        className="flex items-center gap-1 rounded bg-[color:var(--ide-btn-secondary-bg)] px-2 py-0.5 text-[color:var(--ide-text)] hover:bg-[color:var(--ide-btn-secondary-hover)]"
        title="Keep your unsaved edits; ignore the agent's write"
      >
        <X size={12} />
        Keep mine
      </button>
    </div>
  );
}
