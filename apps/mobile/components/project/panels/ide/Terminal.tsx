import { Terminal as TerminalIcon } from "lucide-react-native";

/**
 * Placeholder terminal for the main app.
 *
 * The full xterm.js implementation lives in apps/ide-prototype/src/components/
 * ide/Terminal.tsx and depends on POST /api/term/* routes. The per-project
 * agent runtime (packages/agent-runtime/src/server.ts) does not expose those
 * yet — see the follow-up phase that adds /agent/terminal/{spawn,stream,exec}
 * plus corresponding AgentClient methods.
 *
 * Once those land, replace this file with the real Terminal from the
 * prototype and swap its fetch targets for the SDK.
 */
export function Terminal(_props: { visible: boolean }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-[#1e1e1e] p-6 text-center">
      <TerminalIcon size={28} className="mb-3 text-[#0078d4]" />
      <div className="mb-1 text-[13px] font-semibold text-[#cccccc]">
        Terminal — backend pending
      </div>
      <div className="max-w-md text-[11px] leading-relaxed text-[#858585]">
        A full xterm.js terminal ships alongside the agent-runtime update that
        adds <code className="rounded bg-[#2a2a2a] px-1 text-[#75beff]">POST
        /agent/terminal/exec</code> and an SSE stream. Until then, use the
        Chat tab&apos;s <code className="rounded bg-[#2a2a2a] px-1 text-[#75beff]">exec</code> tool
        for quick shell commands.
      </div>
    </div>
  );
}
