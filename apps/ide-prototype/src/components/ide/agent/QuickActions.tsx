import { useState } from "react";
import { Sparkles, Wand2, FlaskConical, Loader2 } from "lucide-react";
import { runAgentAction, type AgentAction } from "./agentActions";
import type { WorkspaceService } from "../workspace/types";

export interface QuickActionsHandlers {
  /** Called when explain returns text. The host renders the ExplainPanel. */
  onExplainStart: () => void;
  onExplainResult: (text: string) => void;
  onExplainError: (msg: string) => void;
  /** Called after refactor/tests successfully creates a proposal. */
  onProposalCreated: (kind: "refactor" | "tests") => void;
  /** Called for hard failures (network, server). */
  onError: (msg: string) => void;
}

export function QuickActions({
  rootId,
  filePath,
  language,
  getContent,
  service,
  disabled,
  handlers,
}: {
  rootId: string;
  filePath: string;
  language?: string;
  /** Lazy content getter — read from the live editor model, not a stale prop. */
  getContent: () => string;
  /** Service used to write file proposals back through the proposal store. */
  service: WorkspaceService | undefined;
  disabled?: boolean;
  handlers: QuickActionsHandlers;
}) {
  const [busy, setBusy] = useState<AgentAction | null>(null);

  const isDisabled = disabled || !service;

  const run = async (action: AgentAction) => {
    if (busy) return;
    setBusy(action);

    if (action === "explain") handlers.onExplainStart();

    try {
      const result = await runAgentAction({
        action,
        rootId,
        path: filePath,
        content: getContent(),
        language,
      });

      if (result === null) {
        // 204 = nothing to do
        if (action === "refactor") handlers.onError("No changes to propose");
        else if (action === "tests") handlers.onError("Couldn't generate tests for this file");
        else handlers.onExplainError("Empty response");
        return;
      }

      if (result.kind === "text") {
        handlers.onExplainResult(result.body ?? "");
        return;
      }

      // kind === "file": route through writeFile so it becomes a proposal
      if (!service || !result.after || !result.path) {
        handlers.onError("Agent returned an invalid file response");
        return;
      }
      await service.writeFile(result.path, result.after); // review:true by default
      handlers.onProposalCreated(action === "refactor" ? "refactor" : "tests");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (action === "explain") handlers.onExplainError(msg);
      else handlers.onError(`${action} failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const baseBtn =
    "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => void run("explain")}
        disabled={isDisabled || busy !== null}
        title={isDisabled ? "Open a file first" : "Explain this file (agent)"}
        className={`${baseBtn} text-[#cccccc] hover:bg-amber-500/20 hover:text-amber-300`}
      >
        {busy === "explain" ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
        Explain
      </button>
      <button
        onClick={() => void run("refactor")}
        disabled={isDisabled || busy !== null}
        title={isDisabled ? "Open a file first" : "Refactor this file (creates a proposal)"}
        className={`${baseBtn} text-[#cccccc] hover:bg-amber-500/20 hover:text-amber-300`}
      >
        {busy === "refactor" ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
        Refactor
      </button>
      <button
        onClick={() => void run("tests")}
        disabled={isDisabled || busy !== null}
        title={isDisabled ? "Open a file first" : "Generate tests (creates a proposal)"}
        className={`${baseBtn} text-[#cccccc] hover:bg-amber-500/20 hover:text-amber-300`}
      >
        {busy === "tests" ? <Loader2 size={11} className="animate-spin" /> : <FlaskConical size={11} />}
        + Tests
      </button>
    </div>
  );
}
