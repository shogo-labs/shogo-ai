import { useSyncExternalStore } from "react";
import { GitBranch, AlertCircle, AlertTriangle, Check, Sparkles } from "lucide-react";
import { proposalStore } from "./workspace/proposalStore";

function subscribe(fn: () => void) {
  return proposalStore.subscribe(fn);
}
function getCount() {
  return proposalStore.pendingCount();
}

export function StatusBar({
  branch,
  language,
  line,
  col,
  problems,
  warnings,
  saved,
  onOpenProposals,
}: {
  branch: string;
  language: string;
  line: number;
  col: number;
  problems: number;
  warnings: number;
  saved: boolean;
  onOpenProposals?: () => void;
}) {
  const pendingProposals = useSyncExternalStore(subscribe, getCount, getCount);

  return (
    <div className="flex h-6 items-center justify-between bg-[#0078d4] px-3 text-[12px] text-white">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1">
          <GitBranch size={12} /> {branch}
        </span>
        <span className="flex items-center gap-1">
          <AlertCircle size={12} /> {problems}
        </span>
        <span className="flex items-center gap-1">
          <AlertTriangle size={12} /> {warnings}
        </span>
        {pendingProposals > 0 && (
          <button
            onClick={onOpenProposals}
            title="Open Proposals pane"
            className="flex items-center gap-1 rounded bg-amber-500 px-1.5 text-black hover:bg-amber-400"
          >
            <Sparkles size={11} /> {pendingProposals} pending
          </button>
        )}
      </div>
      <div className="flex items-center gap-4">
        <span>
          Ln {line}, Col {col}
        </span>
        <span>{language}</span>
        <span>UTF-8</span>
        <span className="flex items-center gap-1">
          {saved ? <Check size={12} /> : <Circle />}
          {saved ? "Saved" : "Unsaved"}
        </span>
      </div>
    </div>
  );
}

function Circle() {
  return <span className="inline-block h-2 w-2 rounded-full bg-white/80" />;
}
