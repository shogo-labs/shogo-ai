import { useState } from "react";
import { Sparkles, Wand2, FlaskConical, Loader2 } from "lucide-react-native";

export type AgentAction = "explain" | "refactor" | "tests";

/**
 * Payload of the `shogo:agent-action` CustomEvent. The chat panel listens
 * for this event and turns it into an appropriate prompt — same pattern
 * mobile already uses for `shogo:fix-in-agent` from agentFixProvider.ts.
 */
export interface AgentActionEventDetail {
  action: AgentAction;
  rootId: string;
  path: string;
  content: string;
  language?: string;
}

const EVENT_NAME = "shogo:agent-action";

/**
 * Three buttons in the breadcrumbs row that dispatch a CustomEvent on
 * `window`. The host app's chat panel listens for it and produces the
 * actual response — keeps quick-actions decoupled from any specific
 * provider/transport.
 *
 * Fallback behavior: if no listener consumes the event (i.e.
 * preventDefault was never called), we surface a toast so the user
 * isn't left wondering why nothing happened.
 */
export function QuickActions({
  rootId,
  filePath,
  language,
  getContent,
  disabled,
  onFallbackToast,
}: {
  rootId: string;
  filePath: string;
  language?: string;
  /** Lazy content getter — read from the live editor model, not a stale prop. */
  getContent: () => string;
  disabled?: boolean;
  /** Called when no chat-panel listener consumed the event. */
  onFallbackToast?: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<AgentAction | null>(null);

  const fire = (action: AgentAction) => {
    if (busy || disabled) return;
    setBusy(action);

    const detail: AgentActionEventDetail = {
      action,
      rootId,
      path: filePath,
      content: getContent(),
      language,
    };
    const event = new CustomEvent<AgentActionEventDetail>(EVENT_NAME, {
      detail,
      cancelable: true,
    });
    const consumed = !window.dispatchEvent(event); // preventDefault → returns false
    if (!consumed) {
      onFallbackToast?.(
        `No listener for ${EVENT_NAME}. Wire window.addEventListener("${EVENT_NAME}", …) in your chat panel.`,
      );
    }

    // Spinner clears quickly — the chat panel owns the long-running work.
    window.setTimeout(() => setBusy(null), 400);
  };

  const baseBtn =
    "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => fire("explain")}
        disabled={disabled || busy !== null}
        title={disabled ? "Open a file first" : "Explain this file (sends to agent chat)"}
        className={`${baseBtn} text-[color:var(--ide-text)] hover:bg-amber-500/20 hover:text-amber-300`}
      >
        {busy === "explain" ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
        Explain
      </button>
      <button
        onClick={() => fire("refactor")}
        disabled={disabled || busy !== null}
        title={disabled ? "Open a file first" : "Refactor this file (sends to agent chat)"}
        className={`${baseBtn} text-[color:var(--ide-text)] hover:bg-amber-500/20 hover:text-amber-300`}
      >
        {busy === "refactor" ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
        Refactor
      </button>
      <button
        onClick={() => fire("tests")}
        disabled={disabled || busy !== null}
        title={disabled ? "Open a file first" : "Generate tests (sends to agent chat)"}
        className={`${baseBtn} text-[color:var(--ide-text)] hover:bg-amber-500/20 hover:text-amber-300`}
      >
        {busy === "tests" ? <Loader2 size={11} className="animate-spin" /> : <FlaskConical size={11} />}
        + Tests
      </button>
    </div>
  );
}
