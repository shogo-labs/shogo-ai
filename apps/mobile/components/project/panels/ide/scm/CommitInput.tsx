// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Check, ChevronDown, Loader2 } from "lucide-react-native";
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
  committableCount = stagedCount,
  branch,
  onCommit,
  onCommitAndPush,
  onCommitAndSync,
  disabled,
  disabledReason,
}: {
  stagedCount: number;
  committableCount?: number;
  branch?: string | null;
  onCommit: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCommitAndPush: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCommitAndSync: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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

  const hasMessage = message.trim().length > 0;
  const canCommit = !disabled && !busy && hasMessage && committableCount > 0;
  const canAmend = !disabled && !busy && hasMessage;

  const handleCommit = useCallback(async (
    commitFn: typeof onCommit,
    optsOverride?: Partial<{ amend: boolean; signoff: boolean }>,
  ) => {
    setError(null);
    setBusy(true);
    const res = await commitFn(message, { amend: optsOverride?.amend ?? false, signoff: optsOverride?.signoff ?? false });
    setBusy(false);
    if (res.ok) {
      saveToHistory(message);
      setMessage("");
      historyIdxRef.current = -1;
    } else {
      setError(res.error ?? "commit failed");
    }
  }, [message]);

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

      <div className="relative flex px-2 pb-2" ref={menuRef}>
        <button
          onClick={() => void handleCommit(onCommit)}
          disabled={!canCommit}
          className="shogo-primary-commit-button flex-1 flex items-center justify-center gap-1.5 rounded-l-[4px] bg-[#0078d4] text-white text-[12px] font-semibold disabled:bg-[#254563] disabled:text-[color:var(--ide-muted)] disabled:opacity-100 disabled:cursor-not-allowed hover:bg-[#1a8ae8] transition-colors"
          style={{ height: 34 }}
        >
          {busy ? <Loader2 className="animate-spin" size={12} /> : <Check size={12} />}
          Commit
        </button>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={disabled || busy}
          className="flex items-center justify-center rounded-r-[4px] bg-[#0078d4] border-l border-white/25 px-2 text-white disabled:bg-[#254563] disabled:text-[color:var(--ide-muted)] disabled:opacity-100 hover:bg-[#1a8ae8] transition-colors"
          style={{ height: 34 }}
        >
          <ChevronDown size={12} />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-2 top-[38px] z-[1000] min-w-[270px] rounded-[10px] bg-[color:var(--ide-surface)]/95 border border-[color:var(--ide-border)] shadow-2xl py-2 text-[14px] backdrop-blur"
          >
            <MenuItem label="Commit" onClick={() => { setMenuOpen(false); void handleCommit(onCommit); }} disabled={!canCommit} />
            <MenuItem label="Commit (Amend)" onClick={() => { setMenuOpen(false); void handleCommit(onCommit, { amend: true }); }} disabled={!canAmend} />
            <div className="my-1 mx-3 border-t border-[color:var(--ide-border)]" />
            <MenuItem label="Commit & Push" onClick={() => { setMenuOpen(false); void handleCommit(onCommitAndPush); }} disabled={!canCommit} />
            <MenuItem label="Commit & Sync" onClick={() => { setMenuOpen(false); void handleCommit(onCommitAndSync); }} disabled={!canCommit} />
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
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="w-full text-left px-7 py-1.5 text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {label}
    </button>
  );
}
