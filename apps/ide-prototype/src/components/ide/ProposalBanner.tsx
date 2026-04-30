import { useSyncExternalStore } from "react";
import { Sparkles, Eye } from "lucide-react";
import { proposalStore } from "./workspace/proposalStore";

export interface ProposalBannerProps {
  rootId: string;
  path: string;
  onReview: () => void;
  /** True when the editor buffer has unsaved edits (we warn the user). */
  editorDirty?: boolean;
}

function subscribe(fn: () => void) {
  return proposalStore.subscribe(fn);
}

export function ProposalBanner({
  rootId,
  path,
  onReview,
  editorDirty,
}: ProposalBannerProps) {
  const proposal = useSyncExternalStore(
    subscribe,
    () => proposalStore.getByPath(rootId, path),
    () => proposalStore.getByPath(rootId, path),
  );

  if (!proposal) return null;
  const pending = proposal.hunks.filter((h) => h.status === "pending").length;
  if (pending === 0) return null;

  return (
    <div className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-200">
      <Sparkles size={13} className="shrink-0 text-amber-400" />
      <span className="truncate">
        Agent proposed{" "}
        <strong className="font-semibold">
          {pending} change{pending === 1 ? "" : "s"}
        </strong>{" "}
        to this file.
      </span>
      {editorDirty && (
        <span
          title="Editor has unsaved changes; the diff is computed against the on-disk content."
          className="rounded bg-amber-600/40 px-1.5 py-0.5 text-[10px]"
        >
          buffer dirty
        </span>
      )}
      <span className="ml-auto flex items-center gap-1">
        <button
          onClick={() => proposalStore.rejectAll(proposal.id)}
          className="rounded px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
        >
          Reject all
        </button>
        <button
          onClick={() => void proposalStore.acceptAll(proposal.id)}
          className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500"
        >
          Accept all
        </button>
        <button
          onClick={onReview}
          title="Review hunk-by-hunk"
          className="flex items-center gap-1 rounded bg-amber-600/30 px-2 py-0.5 text-[11px] hover:bg-amber-600/50"
        >
          <Eye size={11} /> Review
        </button>
      </span>
    </div>
  );
}
