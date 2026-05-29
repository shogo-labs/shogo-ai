// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Stash list overlay: shows stash@{N}, branch + message, with apply /
// pop / drop actions per entry. Opened from the SCM "..." menu.

import { Archive, Loader2, RotateCcw, Trash2, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { getDesktopGitBridge, type StashEntry } from "./bridge";

export function StashList({
  workspaceRoot,
  onClose,
  onAfterAction,
}: {
  workspaceRoot: string;
  onClose: () => void;
  onAfterAction: () => void;
}) {
  const bridge = getDesktopGitBridge();
  const [entries, setEntries] = useState<StashEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!bridge) return;
    const r = await bridge.stash.list(workspaceRoot);
    if (r.ok && r.entries) setEntries(r.entries);
    else setError(r.error ?? r.reason ?? "failed to list stashes");
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, workspaceRoot]);

  const run = async (label: string, ref: string, fn: () => Promise<{ ok: boolean; error?: string; reason?: string }>) => {
    setBusy(`${label}:${ref}`);
    setError(null);
    const r = await fn();
    setBusy(null);
    if (!r.ok) {
      setError(`${label} failed: ${r.error ?? r.reason ?? "unknown"}`);
      return;
    }
    onAfterAction();
    await refresh();
  };

  if (typeof document === "undefined") return null;
  // `shogo-ide` class is REQUIRED here: the IDE's theme tokens
  // (--ide-surface, --ide-border, ...) are scoped to .shogo-ide in
  // global.css. Portaling moves us outside that ancestor; without the
  // class the card body resolves to transparent. See BranchPicker.tsx.
  return createPortal(
    <div className="shogo-ide fixed inset-0 z-[1000] flex items-start justify-center pt-[120px] bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-[640px] max-h-[60vh] flex flex-col rounded-lg bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[color:var(--ide-border)]">
          <Archive size={13} className="text-[color:var(--ide-muted)]" />
          <span className="text-[13px] text-[color:var(--ide-text-strong)]">Stashes</span>
          <span className="flex-1" />
          <button onClick={onClose} className="p-1 rounded hover:bg-[color:var(--ide-bg)] text-[color:var(--ide-muted)]">
            <X size={12} />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-3 rounded-md bg-rose-500/10 border border-rose-500/30 px-2 py-1.5 text-[12px] text-rose-300 whitespace-pre-wrap">{error}</div>
          )}
          {entries === null && !error && (
            <div className="px-3 py-4 flex items-center gap-2 text-[12px] text-[color:var(--ide-muted)]">
              <Loader2 className="animate-spin" size={12} />
              Listing stashes…
            </div>
          )}
          {entries && entries.length === 0 && !error && (
            <div className="px-3 py-6 text-center text-[12px] text-[color:var(--ide-muted)] italic">No stashes.</div>
          )}
          {entries?.map((s) => (
            <div key={s.ref} className="group flex items-start gap-2 px-3 py-2 hover:bg-[color:var(--ide-bg)] border-b border-[color:var(--ide-border)] last:border-b-0">
              <span className="text-[11px] font-mono text-[color:var(--ide-muted)] mt-0.5">{s.ref}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-[color:var(--ide-text-strong)] truncate">{s.message}</div>
                <div className="text-[11px] text-[color:var(--ide-muted)]">
                  {s.branch && <span>on {s.branch} · </span>}
                  {s.createdAt}
                </div>
              </div>
              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
                <ActionBtn label="Apply" busy={busy === `apply:${s.ref}`} onClick={() => run("apply", s.ref, () => bridge!.stash.apply(workspaceRoot, s.ref))}>
                  <RotateCcw size={11} />
                </ActionBtn>
                <ActionBtn label="Pop" busy={busy === `pop:${s.ref}`} onClick={() => run("pop", s.ref, () => bridge!.stash.pop(workspaceRoot, s.ref))}>
                  <RotateCcw size={11} className="opacity-80" />
                </ActionBtn>
                <ActionBtn label="Drop" busy={busy === `drop:${s.ref}`} onClick={() => run("drop", s.ref, () => bridge!.stash.drop(workspaceRoot, s.ref))} tone="danger">
                  <Trash2 size={11} />
                </ActionBtn>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ActionBtn({ children, label, busy, tone, onClick }: { children: React.ReactNode; label: string; busy: boolean; tone?: "danger"; onClick: () => void }) {
  const cls = tone === "danger" ? "hover:bg-rose-500/20 hover:text-rose-300" : "hover:bg-[color:var(--ide-surface)] hover:text-[color:var(--ide-text-strong)]";
  return (
    <button
      title={label}
      onClick={onClick}
      disabled={busy}
      className={`p-1 rounded text-[color:var(--ide-muted)] disabled:opacity-40 ${cls}`}
    >
      {busy ? <Loader2 className="animate-spin" size={11} /> : children}
    </button>
  );
}
