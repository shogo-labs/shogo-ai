import { useEffect, useRef, useState } from "react";
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
 * Companion event the chat panel can dispatch to signal that an action
 * has finished (success or failure). Lets us clear the spinner the moment
 * work is done instead of guessing with a fixed 400ms timer.
 */
const DONE_EVENT_NAME = "shogo:agent-action-done";

/**
 * If the chat panel claimed the action (via preventDefault) we wait up to
 * this long for the companion `done` event before clearing the spinner
 * defensively. If no listener consumed the action we clear immediately.
 */
const SPINNER_TIMEOUT_MS = 8000;

export interface AgentActionDoneEventDetail {
  action: AgentAction;
}

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
  /**
   * Tracks the active spinner timeout so we can cancel it if a `done` event
   * arrives first. Prevents the fixed-timer disconnect that issue #5 of the
   * PR review flagged: spinner used to clear after 400ms regardless of
   * actual completion.
   */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Listen for the companion `done` event so the spinner can clear the
  // moment the chat panel finishes (success OR failure). Falls back to
  // SPINNER_TIMEOUT_MS if the panel forgets to emit it.
  useEffect(() => {
    const onDone = (e: Event) => {
      const detail = (e as CustomEvent<AgentActionDoneEventDetail>).detail;
      // Only clear if this event matches the busy action — guards against
      // a stray done-event from another component clearing our spinner.
      if (!detail || !busy || detail.action === busy) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        setBusy(null);
      }
    };
    window.addEventListener(DONE_EVENT_NAME, onDone);
    return () => window.removeEventListener(DONE_EVENT_NAME, onDone);
  }, [busy]);

  // Belt-and-braces: clear any outstanding timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

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
      // Nobody is going to emit a `done` event — clear immediately.
      setBusy(null);
      return;
    }

    // Listener took it. Clear the spinner the moment a matching `done`
    // event arrives (handled by the useEffect above) OR after a long
    // safety timeout if the panel forgets to emit one.
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setBusy(null);
    }, SPINNER_TIMEOUT_MS);
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
