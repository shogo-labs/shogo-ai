// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// VS Code-style commit input. Compact single-line textarea, split commit
// button, AI sparkle, commit history (↑/↓). No visible Amend/Sign-off
// checkboxes — those live in the dropdown menu only.

import { Check, ChevronDown, Loader2, RotateCcw, Sparkles } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";

const HISTORY_KEY = "shogo.scm.commitHistory";
const MAX_HISTORY = 50;

function loadHistory(storage?: Record<string, string>): string[] {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : {} as any);
    return JSON.parse(s.getItem?.(HISTORY_KEY) ?? "[]");
  } catch { return []; }
}

function saveToHistory(message: string) {
  const history = loadHistory().filter((m) => m !== message);
  history.unshift(message);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {}
}

export function CommitInput({
  stagedCount,
  totalCount,
  onCommit,
  onCommitAll,
  onCommitAndPush,
  onCommitAndSync,
  onUndoLastCommit,
  onGenerateMessage,
  disabled,
}: {
  stagedCount: number;
  totalCount: number;
  onCommit: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCommitAll: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCommitAndPush: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCommitAndSync: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onUndoLastCommit: () => Promise<{ ok: boolean; error?: string }>;
  onGenerateMessage?: () => Promise<{ ok: boolean; message?: string; error?: string }>;
  disabled?: boolean;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [amend, setAmend] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const historyIdxRef = useRef<number>(-1);

  // ── Dismiss menu on outside click, Escape, or focus loss ──
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    const handleFocusIn = (e: FocusEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    // Delay to avoid the click that opened the menu from closing it
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", handlePointerDown, true);
      document.addEventListener("keydown", handleKeyDown, true);
      document.addEventListener("focusin", handleFocusIn, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
    };
  }, [menuOpen]);

  const canCommit = !disabled && !busy && (amend || (message.trim().length > 0 && (stagedCount > 0 || totalCount > 0)));

  const handleCommit = useCallback(async (commitFn: typeof onCommit) => {
    setError(null);
    setBusy(true);
    const res = await commitFn(message, { amend, signoff: false });
    setBusy(false);
    if (res.ok) {
      saveToHistory(message);
      setMessage("");
      setAmend(false);
      historyIdxRef.current = -1;
    } else {
      setError(res.error ?? "commit failed");
    }
  }, [message, amend]);

  const handleUndoLastCommit = useCallback(async () => {
    setMenuOpen(false);
    setError(null);
    setBusy(true);
    const res = await onUndoLastCommit();
    setBusy(false);
    if (!res.ok) setError(res.error ?? "undo failed");
  }, [onUndoLastCommit]);

  const handleGenerateMessage = useCallback(async () => {
    if (!onGenerateMessage) return;
    setAiBusy(true);
    setError(null);
    const res = await onGenerateMessage();
    setAiBusy(false);
    if (res.ok && res.message) setMessage(res.message);
    else if (!res.ok) setError(res.error ?? "AI generation failed");
  }, [onGenerateMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
      e.preventDefault();
      void handleCommit(onCommit);
      return;
    }
    // History navigation
    if (e.key === "ArrowUp" && message === "") {
      e.preventDefault();
      const history = loadHistory();
      if (historyIdxRef.current < history.length - 1) {
        historyIdxRef.current++;
        setMessage(history[historyIdxRef.current]);
      }
    } else if (e.key === "ArrowDown") {
      const history = loadHistory();
      if (historyIdxRef.current > 0) {
        e.preventDefault();
        historyIdxRef.current--;
        setMessage(history[historyIdxRef.current]);
      } else if (historyIdxRef.current === 0) {
        e.preventDefault();
        historyIdxRef.current = -1;
        setMessage("");
      }
    }
  }, [canCommit, handleCommit, onCommit, message]);

  const placeholder = stagedCount === 0
    ? totalCount === 0
      ? "Message (⌘Enter to commit)"
      : "Stage changes to commit"
    : "Message (⌘Enter to commit)";

  return (
    <div className="border-b border-[color:var(--ide-border)]">
      {/* Commit message textarea — VS Code compact style */}
      <div className="relative px-2 pt-2 pb-1">
        <textarea
          value={message}
          onChange={(e) => { setMessage(e.target.value); historyIdxRef.current = -1; }}
          placeholder={placeholder}
          rows={1}
          disabled={busy}
          onKeyDown={handleKeyDown}
          className="shogo-commit-input w-full resize-none rounded bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] px-2 pr-7 py-[5px] text-[12px] text-[color:var(--ide-text-strong)] placeholder-[color:var(--ide-muted)] focus:outline-none focus:border-[color:var(--ide-primary)]"
          style={{ minHeight: 32, fontFamily: "var(--ide-font, system-ui)" }}
        />
        {/* AI sparkle */}
        {onGenerateMessage && stagedCount > 0 && (
          <button
            title="Generate Commit Message with Copilot"
            onClick={() => void handleGenerateMessage()}
            disabled={aiBusy || busy}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-purple-400 disabled:opacity-40"
          >
            {aiBusy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          </button>
        )}
      </div>

      {/* Split commit button — VS Code style, 36px height */}
      <div className="flex px-2 pb-2">
        <button
          onClick={() => void handleCommit(onCommit)}
          disabled={!canCommit}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-l bg-[#0078d4] text-white text-[12px] font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#1a8ae8] transition-colors"
          style={{ height: 32 }}
        >
          {busy ? <Loader2 className="animate-spin" size={12} /> : <Check size={12} />}
          {amend ? "Amend" : "Commit"}
        </button>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          disabled={disabled || busy}
          className="flex items-center justify-center rounded-r bg-[#0078d4] border-l border-white/20 px-1.5 text-white disabled:opacity-40 hover:bg-[#1a8ae8] transition-colors"
          style={{ height: 32 }}
        >
          <ChevronDown size={12} />
        </button>

        {/* Dropdown menu */}
        {menuOpen && (
          <div
            ref={menuRef}
            className="absolute left-2 mt-1 z-[1000] w-[220px] rounded bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] shadow-xl py-1 text-[12px]"
          >
            <MenuItem label="Commit" hint="Stage and commit" onClick={() => { setMenuOpen(false); void handleCommit(onCommit); }} disabled={stagedCount === 0} />
            <MenuItem label="Commit All" hint="Stage all + commit" onClick={() => { setMenuOpen(false); void handleCommit(onCommitAll); }} disabled={totalCount === 0} />
            <MenuItem label="Commit & Push" hint="Commit and push to remote" onClick={() => { setMenuOpen(false); void handleCommit(onCommitAndPush); }} disabled={stagedCount === 0} />
            <MenuItem label="Commit & Sync" hint="Pull + commit + push" onClick={() => { setMenuOpen(false); void handleCommit(onCommitAndSync); }} disabled={stagedCount === 0} />
            <div className="my-1 border-t border-[color:var(--ide-border)]" />
            <MenuItem
              label={amend ? "✓ Amend" : "Amend"}
              hint="Replace previous commit"
              onClick={() => { setMenuOpen(false); setAmend((v) => !v); }}
            />
            <div className="my-1 border-t border-[color:var(--ide-border)]" />
            <MenuItem
              label="Undo Last Commit"
              hint="git reset --soft HEAD~1"
              onClick={handleUndoLastCommit}
              icon={<RotateCcw size={10} />}
            />
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-2 mb-2 rounded bg-rose-500/10 border border-rose-500/30 px-2 py-1 text-[10px] text-rose-300 whitespace-pre-wrap">
          {error}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  hint,
  onClick,
  icon,
  disabled,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="w-full text-left px-3 py-1 hover:bg-[color:var(--ide-hover)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
    >
      {icon ?? <span className="w-[10px]" />}
      <div className="flex-1 min-w-0">
        <div className="text-[color:var(--ide-text-strong)] truncate">{label}</div>
        {hint && <div className="text-[10px] text-[color:var(--ide-muted)] truncate">{hint}</div>}
      </div>
    </button>
  );
}
