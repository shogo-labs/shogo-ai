// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Check, ChevronDown, Loader2, RotateCcw } from "lucide-react-native";
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
  branch,
  onCommit,
  onCommitAll,
  onCommitAndPush,
  onCommitAndSync,
  onUndoLastCommit,
  disabled,
  disabledReason,
}: {
  stagedCount: number;
  totalCount: number;
  branch?: string | null;
  onCommit: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCommitAll: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCommitAndPush: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCommitAndSync: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onUndoLastCommit: () => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [amend, setAmend] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const historyIdxRef = useRef<number>(-1);

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

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
      e.preventDefault();
      void handleCommit(onCommit);
      return;
    }
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

  const branchSuffix = branch ? ` on "${branch}"` : "";
  const placeholder = disabledReason ?? `Message (⌘Enter to commit${branchSuffix})`;

  return (
    <div>
      <div className="relative px-2 pt-1 pb-1">
        <input
          value={message}
          onChange={(e) => { setMessage(e.target.value); historyIdxRef.current = -1; }}
          placeholder={placeholder}
          disabled={busy || disabled}
          onKeyDown={handleKeyDown}
          className="shogo-commit-input w-full rounded-[4px] bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] px-2 text-[12px] text-[color:var(--ide-text-strong)] placeholder-[color:var(--ide-muted)] focus:outline-none focus:border-[color:var(--ide-primary)]"
          style={{ height: 32, fontFamily: "var(--ide-font, system-ui)" }}
        />
      </div>

      <div className="flex px-2 pb-2">
        <button
          onClick={() => void handleCommit(onCommit)}
          disabled={!canCommit}
          className="shogo-primary-commit-button flex-1 flex items-center justify-center gap-1.5 rounded-l-[4px] bg-[#0078d4] text-white text-[12px] font-semibold disabled:bg-[#254563] disabled:text-[color:var(--ide-muted)] disabled:opacity-100 disabled:cursor-not-allowed hover:bg-[#1a8ae8] transition-colors"
          style={{ height: 34 }}
        >
          {busy ? <Loader2 className="animate-spin" size={12} /> : <Check size={12} />}
          {amend ? "Amend" : "Commit"}
        </button>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          disabled={disabled || busy}
          className="flex items-center justify-center rounded-r-[4px] bg-[#0078d4] border-l border-white/25 px-2 text-white disabled:bg-[#254563] disabled:text-[color:var(--ide-muted)] disabled:opacity-100 hover:bg-[#1a8ae8] transition-colors"
          style={{ height: 34 }}
        >
          <ChevronDown size={12} />
        </button>

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

      {disabledReason && (
        <div className="mx-2 mb-2 rounded bg-amber-500/10 border border-amber-500/30 px-2 py-1 text-[10px] text-amber-200 whitespace-pre-wrap">
          {disabledReason}
        </div>
      )}

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
