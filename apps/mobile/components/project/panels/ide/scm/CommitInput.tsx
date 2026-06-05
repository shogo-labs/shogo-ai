// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Commit input with split-button dropdown, AI message generation,
// and commit message history (arrow up/down).

import { Check, ChevronDown, Loader2, RotateCcw, Sparkles } from "lucide-react-native";
import { useCallback, useRef, useState } from "react";

const HISTORY_KEY = "shogo.scm.commitHistory";
const MAX_HISTORY = 50;

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveToHistory(message: string) {
  const history = loadHistory().filter((m) => m !== message);
  history.unshift(message);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
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
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyIdxRef = useRef<number>(-1);

  const canCommit = !disabled && !busy && (amend || (message.trim().length > 0 && (stagedCount > 0 || totalCount > 0)));

  const handleCommit = useCallback(async (commitFn: typeof onCommit) => {
    setError(null);
    setBusy(true);
    const res = await commitFn(message, { amend, signoff });
    setBusy(false);
    if (res.ok) {
      saveToHistory(message);
      setMessage("");
      setAmend(false);
      historyIdxRef.current = -1;
    } else {
      setError(res.error ?? "commit failed");
    }
  }, [message, amend, signoff]);

  const handleUndoLastCommit = useCallback(async () => {
    setMenuOpen(false);
    setError(null);
    setBusy(true);
    const res = await onUndoLastCommit();
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "undo failed");
    }
  }, [onUndoLastCommit]);

  const handleGenerateMessage = useCallback(async () => {
    if (!onGenerateMessage) return;
    setAiBusy(true);
    setError(null);
    const res = await onGenerateMessage();
    setAiBusy(false);
    if (res.ok && res.message) {
      setMessage(res.message);
    } else if (!res.ok) {
      setError(res.error ?? "AI generation failed");
    }
  }, [onGenerateMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
      e.preventDefault();
      void handleCommit(onCommit);
      return;
    }
    // Arrow up/down for commit message history
    if (e.key === "ArrowUp" && message === "") {
      e.preventDefault();
      const history = loadHistory();
      if (history.length === 0) return;
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

  return (
    <div className="flex flex-col gap-2 border-b border-[color:var(--ide-border)] p-3">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => { setMessage(e.target.value); historyIdxRef.current = -1; }}
          placeholder={
            stagedCount === 0
              ? totalCount === 0
                ? "No changes to commit"
                : "Stage changes to commit"
              : `Message (⌘⏎ to commit ${stagedCount} ${stagedCount === 1 ? "file" : "files"})`
          }
          rows={1}
          disabled={busy}
          onKeyDown={handleKeyDown}
          className="resize-none rounded-md bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] px-2 pr-8 py-1.5 text-[13px] text-[color:var(--ide-text-strong)] placeholder-[color:var(--ide-muted)] focus:outline-none focus:border-[color:var(--ide-primary)] w-full"
        />
        {onGenerateMessage && stagedCount > 0 && (
          <button
            title="Generate commit message with AI"
            onClick={() => void handleGenerateMessage()}
            disabled={aiBusy || busy}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-purple-400 disabled:opacity-40"
          >
            {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          </button>
        )}
      </div>
      {/* Split commit button: primary action + dropdown */}
      <div className="flex">
        <button
          onClick={() => void handleCommit(amend ? onCommit : onCommit)}
          disabled={!canCommit}
          className="flex-1 flex items-center justify-center gap-2 rounded-l-md bg-[color:var(--ide-primary)] py-1.5 text-[13px] font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
        >
          {busy ? <Loader2 className="animate-spin" size={13} /> : <Check size={13} />}
          {amend ? "Amend commit" : "Commit"}
        </button>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          disabled={disabled || busy}
          className="flex items-center justify-center rounded-r-md border-l border-white/20 bg-[color:var(--ide-primary)] px-1.5 py-1.5 text-white disabled:opacity-40 hover:opacity-90"
        >
          <ChevronDown size={12} />
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            className="absolute left-0 mt-[calc(100%-2px)] z-[1000] w-[240px] rounded-md bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] shadow-2xl py-1 text-[13px]"
          >
            <CommitMenuItem
              label="Commit All"
              hint={`${totalCount} file${totalCount !== 1 ? "s" : ""} (staged + unstaged)`}
              onClick={() => { setMenuOpen(false); void handleCommit(onCommitAll); }}
              disabled={totalCount === 0 || busy}
            />
            <CommitMenuItem
              label="Commit & Push"
              hint="Commit staged changes and push to remote"
              onClick={() => { setMenuOpen(false); void handleCommit(onCommitAndPush); }}
              disabled={stagedCount === 0 || busy}
            />
            <CommitMenuItem
              label="Commit & Sync"
              hint="Pull (rebase) + commit + push"
              onClick={() => { setMenuOpen(false); void handleCommit(onCommitAndSync); }}
              disabled={stagedCount === 0 || busy}
            />
            <CommitMenuItem
              label="Commit (Amend)"
              hint="Replace previous commit"
              onClick={() => { setMenuOpen(false); setAmend(true); }}
              disabled={busy}
            />
            <div className="my-1 border-t border-[color:var(--ide-border)]" />
            <CommitMenuItem
              label="Undo Last Commit"
              hint="git reset --soft HEAD~1"
              onClick={handleUndoLastCommit}
              icon={<RotateCcw size={11} />}
              disabled={busy}
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 text-[11px] text-[color:var(--ide-muted)]">
        <label className="flex items-center gap-1 cursor-pointer hover:text-[color:var(--ide-text-strong)]">
          <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} className="accent-[color:var(--ide-primary)]" />
          Amend
        </label>
        <label className="flex items-center gap-1 cursor-pointer hover:text-[color:var(--ide-text-strong)]">
          <input type="checkbox" checked={signoff} onChange={(e) => setSignoff(e.target.checked)} className="accent-[color:var(--ide-primary)]" />
          Sign off
        </label>
      </div>
      {error && (
        <div className="rounded-md bg-rose-500/10 border border-rose-500/30 px-2 py-1.5 text-[11px] text-rose-300 whitespace-pre-wrap">
          {error}
        </div>
      )}
    </div>
  );
}

function CommitMenuItem({
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
      className="w-full text-left px-3 py-1.5 hover:bg-[color:var(--ide-bg)] disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <div className="flex items-center gap-2">
        {icon ?? <Check size={11} className="text-[color:var(--ide-muted)]" />}
        <span className="text-[color:var(--ide-text-strong)]">{label}</span>
      </div>
      {hint && <div className="text-[10px] text-[color:var(--ide-muted)] ml-[19px]">{hint}</div>}
    </button>
  );
}