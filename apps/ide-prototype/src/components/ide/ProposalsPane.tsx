import { useSyncExternalStore, useState } from "react";
import { Sparkles, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { proposalStore, type Proposal } from "./workspace/proposalStore";
import { HunkDiff } from "./HunkDiff";

export interface ProposalsPaneProps {
  /** Open the file in the editor. */
  onOpenFile: (rootId: string, path: string) => void;
  /** Optional: focus a specific proposal id when this pane mounts. */
  focusProposalId?: string | null;
}

function subscribe(fn: () => void) {
  return proposalStore.subscribe(fn);
}
function getSnapshot() {
  return proposalStore.list();
}

export function ProposalsPane({ onOpenFile, focusProposalId }: ProposalsPaneProps) {
  const proposals = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const totalPending = proposals.reduce(
    (acc, p) => acc + p.hunks.filter((h) => h.status === "pending").length,
    0,
  );

  return (
    <div className="flex h-full flex-col text-[#cccccc]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a2a2a]">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-amber-400" />
          <span className="text-[11px] uppercase tracking-wide font-medium">
            Proposals
          </span>
          {proposals.length > 0 && (
            <span className="rounded bg-[#3a3a3a] px-1.5 py-0.5 text-[10px]">
              {proposals.length} file{proposals.length === 1 ? "" : "s"} ·{" "}
              {totalPending} pending
            </span>
          )}
        </div>
        {proposals.length > 0 && (
          <button
            onClick={() => proposalStore.rejectAllProposals()}
            title="Reject all proposals"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#2a2a2a] hover:text-red-400"
          >
            <Trash2 size={11} /> Reject all
          </button>
        )}
      </div>

      {proposals.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {proposals.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              collapsed={collapsed.has(p.id) && p.id !== focusProposalId}
              onToggle={() => toggle(p.id)}
              onOpenFile={() => onOpenFile(p.rootId, p.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-[#858585]">
      <Sparkles size={28} className="opacity-40" />
      <p className="text-[12px]">No pending agent edits.</p>
      <p className="text-[11px] leading-relaxed">
        When the agent proposes file changes, they appear here for review
        before being written to disk.
      </p>
    </div>
  );
}

function ProposalCard({
  proposal,
  collapsed,
  onToggle,
  onOpenFile,
}: {
  proposal: Proposal;
  collapsed: boolean;
  onToggle: () => void;
  onOpenFile: () => void;
}) {
  const pending = proposal.hunks.filter((h) => h.status === "pending").length;
  const accepted = proposal.hunks.filter((h) => h.status === "accepted").length;
  const rejected = proposal.hunks.filter((h) => h.status === "rejected").length;

  return (
    <div className="rounded-md border border-[#2a2a2a] bg-[#1e1e1e]">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#2a2a2a]">
        <button
          onClick={onToggle}
          className="text-[#858585] hover:text-white"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <button
          onClick={onOpenFile}
          className="flex-1 truncate text-left text-[12px] font-mono hover:underline"
          title={`Open ${proposal.path}`}
        >
          {proposal.path}
        </button>
        <div className="flex items-center gap-1 text-[10px] text-[#858585]">
          {pending > 0 && (
            <span className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-300">
              {pending} pending
            </span>
          )}
          {accepted > 0 && (
            <span className="rounded bg-emerald-500/15 px-1 py-0.5 text-emerald-300">
              {accepted}✓
            </span>
          )}
          {rejected > 0 && (
            <span className="rounded bg-red-500/15 px-1 py-0.5 text-red-300">
              {rejected}✗
            </span>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          {proposal.rationale && (
            <div className="px-3 py-1.5 text-[11px] text-[#858585] border-b border-[#2a2a2a] italic">
              {proposal.rationale}
            </div>
          )}
          <div className="p-2 space-y-2">
            {proposal.hunks.map((h) => (
              <HunkDiff
                key={h.id}
                hunk={h}
                onAccept={() => void proposalStore.acceptHunk(proposal.id, h.id)}
                onReject={() => proposalStore.rejectHunk(proposal.id, h.id)}
              />
            ))}
          </div>
          <div className="flex items-center justify-end gap-1 border-t border-[#2a2a2a] px-2 py-1.5">
            <button
              onClick={() => proposalStore.rejectAll(proposal.id)}
              className="rounded px-2 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10"
            >
              Reject all
            </button>
            <button
              onClick={() => void proposalStore.acceptAll(proposal.id)}
              disabled={pending === 0}
              className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Accept all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
