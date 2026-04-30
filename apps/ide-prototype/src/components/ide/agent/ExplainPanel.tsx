import { Sparkles, X, Loader2, AlertTriangle, RotateCw } from "lucide-react";

export interface ExplainState {
  fileId: string;
  filePath: string;
  loading: boolean;
  text: string | null;
  error: string | null;
}

export function ExplainPanel({
  state,
  onClose,
  onRetry,
}: {
  state: ExplainState;
  onClose: () => void;
  onRetry: () => void;
}) {
  const baseName = state.filePath.split("/").pop() ?? state.filePath;

  return (
    <div className="border-b border-amber-500/40 bg-amber-500/5 text-[12px] text-[#cccccc]">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Sparkles size={13} className="text-amber-400" />
        <span className="font-medium">Explain</span>
        <span className="text-[#858585]">·</span>
        <span className="font-mono text-[11px] text-[#858585]">{baseName}</span>
        <span className="ml-auto flex items-center gap-1">
          {state.error && (
            <button
              onClick={onRetry}
              title="Retry"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-amber-300 hover:bg-amber-500/20"
            >
              <RotateCw size={11} /> Retry
            </button>
          )}
          <button
            onClick={onClose}
            title="Close"
            className="rounded p-0.5 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            <X size={13} />
          </button>
        </span>
      </div>

      <div className="max-h-[40vh] overflow-y-auto px-3 pb-3 pt-1">
        {state.loading && (
          <div className="space-y-1.5 py-1">
            <SkeletonLine width="92%" />
            <SkeletonLine width="68%" />
            <SkeletonLine width="80%" />
            <div className="flex items-center gap-1.5 pt-1 text-[11px] text-[#858585]">
              <Loader2 size={11} className="animate-spin" /> Asking agent…
            </div>
          </div>
        )}

        {state.error && !state.loading && (
          <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Couldn't explain this file</div>
              <div className="mt-0.5 font-mono text-[10px] text-red-400/80">{state.error}</div>
            </div>
          </div>
        )}

        {state.text && !state.loading && !state.error && (
          <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-[#cccccc]">
            {state.text}
          </pre>
        )}
      </div>
    </div>
  );
}

function SkeletonLine({ width }: { width: string }) {
  return (
    <div className="h-2.5 rounded bg-[#3a3a3a]/60 animate-pulse" style={{ width }} />
  );
}
