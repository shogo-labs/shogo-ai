import { GitBranch } from "lucide-react";

/**
 * Placeholder Source Control pane for the main app.
 *
 * The full implementation lives in apps/ide-prototype/src/components/ide/
 * GitPane.tsx and requires the following routes on the per-project agent
 * runtime (packages/agent-runtime/src/server.ts) which don't exist yet:
 *   GET  /agent/git/status
 *   POST /agent/git/{stage,unstage,discard,commit}
 *   GET  /agent/git/diff?path=…&staged=0|1
 *
 * Once those land + AgentClient gains .git* methods, restore the prototype
 * GitPane and swap its fetches for the SDK.
 */
export function GitPane(_props: { onOpenDiff: (path: string, staged: boolean) => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-[#1e1e1e] p-6 text-center">
      <GitBranch size={28} className="mb-3 text-[#0078d4]" />
      <div className="mb-1 text-[13px] font-semibold text-[#cccccc]">
        Source Control — backend pending
      </div>
      <div className="max-w-md text-[11px] leading-relaxed text-[#858585]">
        Git status, stage, commit, and diff land together with the
        agent-runtime git routes
        (<code className="rounded bg-[#2a2a2a] px-1 text-[#75beff]">/agent/git/*</code>).
        Track progress on the{" "}
        <code className="rounded bg-[#2a2a2a] px-1 text-[#75beff]">feat/shogo-IDE</code>{" "}
        branch.
      </div>
    </div>
  );
}
