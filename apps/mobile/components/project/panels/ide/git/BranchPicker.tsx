// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Branch quick-pick overlay. Opened from the StatusBar branch segment
// and from the SCM viewlet "..." menu. Lists local + remote branches,
// supports fuzzy filter, "Create new branch", and one-click checkout.

import { Check, GitBranch, Loader2, Plus, X } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { BranchInfo } from "./bridge";
import { getDesktopGitBridge } from "./bridge";

export function BranchPicker({
  workspaceRoot,
  currentBranch,
  onClose,
  onChanged,
}: {
  workspaceRoot: string;
  currentBranch: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const bridge = getDesktopGitBridge();
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.branches.list(workspaceRoot).then((r) => {
      if (cancelled) return;
      if (r.ok && r.branches) setBranches(r.branches);
      else setError(r.error ?? r.reason ?? "failed to list branches");
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, workspaceRoot]);

  const filtered = useMemo(() => {
    if (!branches) return [];
    const q = query.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, query]);

  const handleCheckout = async (name: string) => {
    if (!bridge) return;
    setBusy(name);
    setError(null);
    const r = await bridge.branches.checkout(workspaceRoot, name);
    setBusy(null);
    if (r.ok) {
      onChanged();
      onClose();
    } else {
      setError(r.error ?? r.reason ?? "checkout failed");
    }
  };

  const handleCreate = async () => {
    if (!bridge || !newName.trim()) return;
    setBusy("__create__");
    setError(null);
    const r = await bridge.branches.create(workspaceRoot, newName.trim());
    setBusy(null);
    if (r.ok) {
      onChanged();
      onClose();
    } else {
      setError(r.error ?? r.reason ?? "create failed");
    }
  };

  // Portal to <body> so the modal escapes any IDE pane's stacking
  // context / containing block (a `transform` / `filter` / `contain`
  // ancestor would otherwise reparent our `fixed` element and clip it).
  //
  // The outer wrapper KEEPS the `shogo-ide` class because the IDE's
  // theme tokens (`--ide-surface`, `--ide-border`, etc.) are scoped to
  // `.shogo-ide` in global.css. Portaling moves the DOM outside any
  // `.shogo-ide` ancestor, so without re-applying the class, every
  // `var(--ide-*)` resolves to nothing and the card paints transparent.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="shogo-ide fixed inset-0 z-[1000] flex items-start justify-center pt-[120px] bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[640px] max-h-[60vh] flex flex-col rounded-lg bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[color:var(--ide-border)]">
          <GitBranch size={14} className="text-[color:var(--ide-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter branches…"
            className="flex-1 bg-transparent text-[13px] focus:outline-none placeholder-[color:var(--ide-muted)]"
          />
          <button
            onClick={() => setCreating((v) => !v)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-bg)]"
            title="Create new branch"
          >
            <Plus size={11} /> New
          </button>
          <button onClick={onClose} className="p-1 rounded hover:bg-[color:var(--ide-bg)] text-[color:var(--ide-muted)]">
            <X size={12} />
          </button>
        </div>

        {creating && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-bg)]">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new-branch-name"
              autoFocus
              className="flex-1 bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] rounded px-2 py-1 text-[13px] focus:outline-none focus:border-[color:var(--ide-primary)]"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || busy === "__create__"}
              className="flex items-center gap-1 px-2 py-1 rounded bg-[color:var(--ide-primary)] text-white text-[12px] disabled:opacity-40"
            >
              {busy === "__create__" ? <Loader2 className="animate-spin" size={11} /> : <Plus size={11} />}
              Create &amp; checkout
            </button>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-3 rounded-md bg-rose-500/10 border border-rose-500/30 px-2 py-1.5 text-[12px] text-rose-300 whitespace-pre-wrap">
              {error}
            </div>
          )}
          {branches === null && !error && (
            <div className="px-3 py-4 flex items-center gap-2 text-[12px] text-[color:var(--ide-muted)]">
              <Loader2 className="animate-spin" size={12} />
              Listing branches…
            </div>
          )}
          {filtered.map((b) => (
            <button
              key={b.fullRef}
              onClick={() => handleCheckout(b.name)}
              disabled={busy === b.name}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[color:var(--ide-bg)] disabled:opacity-50"
            >
              {b.isHead ? (
                <Check size={12} className="text-emerald-400 shrink-0" />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span
                className={
                  b.isHead
                    ? "text-[color:var(--ide-text-strong)] font-medium"
                    : "text-[color:var(--ide-text-strong)]"
                }
              >
                {b.name}
              </span>
              {b.isRemote && <span className="text-[10px] px-1 rounded bg-[color:var(--ide-bg)] text-[color:var(--ide-muted)]">remote</span>}
              {b.upstream && !b.isRemote && (
                <span className="text-[10px] text-[color:var(--ide-muted)] truncate">↑ {b.upstream}</span>
              )}
              <span className="flex-1" />
              <span className="text-[11px] text-[color:var(--ide-muted)] truncate max-w-[280px]" title={b.subject}>
                {b.subject}
              </span>
              {busy === b.name && <Loader2 className="animate-spin" size={11} />}
            </button>
          ))}
          {filtered.length === 0 && branches !== null && !error && (
            <div className="px-3 py-4 text-[12px] text-[color:var(--ide-muted)] italic">No branches match &ldquo;{query}&rdquo;.</div>
          )}
        </div>
        <div className="px-3 py-1.5 border-t border-[color:var(--ide-border)] text-[10px] text-[color:var(--ide-muted)] flex items-center justify-between">
          <span>Current: <span className="text-[color:var(--ide-text-strong)]">{currentBranch ?? "—"}</span></span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
