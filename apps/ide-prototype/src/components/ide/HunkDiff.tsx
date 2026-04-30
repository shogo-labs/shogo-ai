import { Check, X, MinusCircle, PlusCircle } from "lucide-react";
import type { Hunk } from "./workspace/proposalStore";

export interface HunkDiffProps {
  hunk: Hunk;
  onAccept: () => void;
  onReject: () => void;
  /** Suppress accept/reject buttons (e.g. when proposal is read-only). */
  readOnly?: boolean;
}

/**
 * Unified-diff renderer for a single hunk with per-hunk accept/reject controls.
 * Layout intentionally mirrors a typical PR review surface: removed lines first,
 * added lines below, both monospace.
 */
export function HunkDiff({ hunk, onAccept, onReject, readOnly }: HunkDiffProps) {
  const acted = hunk.status !== "pending";

  return (
    <div className="rounded-md border border-[#2a2a2a] bg-[#1e1e1e] overflow-hidden text-[12px]">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[#2a2a2a] bg-[#252526]">
        <span className="text-[10px] font-mono text-[#858585]">
          @@ -{hunk.beforeStart},{hunk.beforeLines.length} +{hunk.afterStart},
          {hunk.afterLines.length} @@
        </span>
        <span className="ml-auto flex items-center gap-1">
          {hunk.status === "accepted" && (
            <span className="text-[10px] flex items-center gap-1 text-emerald-400">
              <Check size={11} /> accepted
            </span>
          )}
          {hunk.status === "rejected" && (
            <span className="text-[10px] flex items-center gap-1 text-red-400">
              <X size={11} /> rejected
            </span>
          )}
          {!acted && !readOnly && (
            <>
              <button
                onClick={onReject}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-red-400 hover:bg-red-500/10"
                title="Reject this hunk"
              >
                Reject
              </button>
              <button
                onClick={onAccept}
                className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-500"
                title="Accept this hunk"
              >
                Accept
              </button>
            </>
          )}
        </span>
      </div>

      <div className="font-mono">
        {hunk.beforeLines.length === 0 && hunk.afterLines.length === 0 && (
          <div className="px-2 py-1 text-[#858585] italic">(empty hunk)</div>
        )}

        {hunk.beforeLines.map((line, i) => (
          <div
            key={`b${i}`}
            className="flex bg-red-500/10 text-red-300/90"
          >
            <span className="w-7 shrink-0 select-none text-right pr-1.5 text-[#858585]">
              <MinusCircle size={10} className="inline" />
            </span>
            <span className="w-10 shrink-0 select-none text-right pr-2 text-[#858585]">
              {hunk.beforeStart + i}
            </span>
            <pre className="flex-1 whitespace-pre-wrap break-all py-0.5 pr-2">
              {line || " "}
            </pre>
          </div>
        ))}

        {hunk.afterLines.map((line, i) => (
          <div
            key={`a${i}`}
            className="flex bg-emerald-500/10 text-emerald-300/90"
          >
            <span className="w-7 shrink-0 select-none text-right pr-1.5 text-[#858585]">
              <PlusCircle size={10} className="inline" />
            </span>
            <span className="w-10 shrink-0 select-none text-right pr-2 text-[#858585]">
              {hunk.afterStart + i}
            </span>
            <pre className="flex-1 whitespace-pre-wrap break-all py-0.5 pr-2">
              {line || " "}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
