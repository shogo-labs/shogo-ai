// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Check, Loader2 } from "lucide-react-native";
import { useState } from "react";

export function CommitInput({
  stagedCount,
  onCommit,
  disabled,
}: {
  stagedCount: number;
  onCommit: (message: string, opts: { amend: boolean; signoff: boolean }) => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);

  const canCommit = !disabled && !busy && (amend || (message.trim().length > 0 && stagedCount > 0));

  const handleCommit = async () => {
    setError(null);
    setBusy(true);
    const res = await onCommit(message, { amend, signoff });
    setBusy(false);
    if (res.ok) {
      setMessage("");
      setAmend(false);
    } else {
      setError(res.error ?? "commit failed");
    }
  };

  return (
    <div className="flex flex-col gap-2 border-b border-[color:var(--ide-border)] p-3">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={
          stagedCount === 0
            ? "Stage changes to commit"
            : `Message (⌘⏎ to commit ${stagedCount} ${stagedCount === 1 ? "file" : "files"})`
        }
        rows={3}
        disabled={busy}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
            e.preventDefault();
            void handleCommit();
          }
        }}
        className="resize-none rounded-md bg-[color:var(--ide-surface)] border border-[color:var(--ide-border)] px-2 py-1.5 text-[13px] text-[color:var(--ide-text-strong)] placeholder-[color:var(--ide-muted)] focus:outline-none focus:border-[color:var(--ide-primary)]"
      />
      <button
        onClick={handleCommit}
        disabled={!canCommit}
        className="flex items-center justify-center gap-2 rounded-md bg-[color:var(--ide-primary)] py-1.5 text-[13px] font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
      >
        {busy ? <Loader2 className="animate-spin" size={13} /> : <Check size={13} />}
        {amend ? "Amend commit" : "Commit"}
      </button>
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
