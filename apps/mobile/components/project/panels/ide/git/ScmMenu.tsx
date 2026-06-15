// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { ArrowDown, ArrowUp, Loader2, RefreshCw, X } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";

import { getDesktopGitBridge } from "./bridge";

interface ScmMenuProps {
  workspaceRoot: string;
  onClose: () => void;
  onAfterAction: () => void;
  onOpenBranchPicker: () => void;
  onOpenStashList: () => void;
}

export function ScmMenu({ workspaceRoot, onClose, onAfterAction, onOpenBranchPicker, onOpenStashList }: ScmMenuProps) {
  const bridge = getDesktopGitBridge();
  const menuRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", handlePointerDown, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("focusin", handleFocusIn, true);
    return () => document.removeEventListener("focusin", handleFocusIn, true);
  }, [onClose]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ phase: string; percent: number | null } | null>(null);

  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string; reason?: string }>) => {
    setBusy(label);
    setError(null);
    setProgress(null);
    const r = await fn();
    setBusy(null);
    setProgress(null);
    if (!r.ok) {
      setError(`${label}: ${r.error ?? r.reason ?? "failed"}`);
      return;
    }
    onAfterAction();
    onClose();
  };

  if (!bridge) return null;

  const onProgress = (p: { phase: string; percent: number | null }) => setProgress({ phase: p.phase, percent: p.percent });

  const items: { label: string; icon: typeof RefreshCw; fn: () => Promise<{ ok: boolean; error?: string; reason?: string }> }[] = [
    { label: "Fetch", icon: ArrowDown, fn: () => bridge.fetchStreaming(workspaceRoot, { prune: true }, onProgress) },
    { label: "Pull", icon: ArrowDown, fn: () => bridge.pullStreaming(workspaceRoot, {}, onProgress) },
    { label: "Pull (rebase)", icon: ArrowDown, fn: () => bridge.pullStreaming(workspaceRoot, { rebase: true }, onProgress) },
    { label: "Push", icon: ArrowUp, fn: () => bridge.pushStreaming(workspaceRoot, {}, onProgress) },
    { label: "Push (force with lease)", icon: ArrowUp, fn: () => bridge.pushStreaming(workspaceRoot, { forceWithLease: true }, onProgress) },
    { label: "Sync (fetch · pull · push)", icon: RefreshCw, fn: () => bridge.remotes.sync(workspaceRoot, {}) },
  ];

  return (
    <div ref={menuRef} className="absolute right-2 top-9 z-[1000] w-[260px] rounded-md bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] shadow-2xl py-1 text-[13px]">
      <MenuHeader>Remote</MenuHeader>
      {items.map((it) => (
        <button
          key={it.label}
          disabled={busy !== null}
          onClick={() => run(it.label, it.fn)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[color:var(--ide-bg)] disabled:opacity-50"
        >
          {busy === it.label ? <Loader2 className="animate-spin" size={12} /> : <it.icon size={12} className="text-[color:var(--ide-muted)]" />}
          <span className="text-[color:var(--ide-text-strong)]">{it.label}</span>
          {busy === it.label && progress && (
            <span className="ml-auto text-[10px] text-[color:var(--ide-muted)] truncate max-w-[120px]" title={progress.phase}>
              {progress.percent != null ? `${progress.percent}%` : progress.phase}
            </span>
          )}
        </button>
      ))}
      <MenuSep />
      <MenuHeader>Branches</MenuHeader>
      <button onClick={() => { onOpenBranchPicker(); onClose() }} className="w-full text-left px-3 py-1.5 hover:bg-[color:var(--ide-bg)] text-[color:var(--ide-text-strong)]">
        Branch picker…
      </button>
      <MenuSep />
      <MenuHeader>Stash</MenuHeader>
      <button
        disabled={busy !== null}
        onClick={() => run("Stash push", () => bridge.stash.push(workspaceRoot, { includeUntracked: true }))}
        className="w-full text-left px-3 py-1.5 hover:bg-[color:var(--ide-bg)] text-[color:var(--ide-text-strong)] disabled:opacity-50"
      >
        Stash all changes (incl. untracked)
      </button>
      <button onClick={() => { onOpenStashList(); onClose() }} className="w-full text-left px-3 py-1.5 hover:bg-[color:var(--ide-bg)] text-[color:var(--ide-text-strong)]">
        Stashes…
      </button>
      {error && (
        <>
          <MenuSep />
          <div className="m-2 rounded bg-rose-500/10 border border-rose-500/30 px-2 py-1.5 text-[11px] text-rose-300 whitespace-pre-wrap flex items-start gap-1">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-rose-300/70 hover:text-rose-300">
              <X size={11} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MenuHeader({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-[color:var(--ide-muted)]">{children}</div>;
}

function MenuSep() {
  return <div className="my-1 border-t border-[color:var(--ide-border)]" />;
}
