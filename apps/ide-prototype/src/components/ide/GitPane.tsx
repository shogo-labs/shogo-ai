import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  RotateCcw,
  Check,
  FileText,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { api } from "./workspace/apiBase";

interface GitFile {
  path: string;
  status: string;
}

interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: string[];
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  M: { label: "M", color: "text-[#dcdcaa]" },
  A: { label: "A", color: "text-[#4ec9b0]" },
  D: { label: "D", color: "text-[#f48771]" },
  R: { label: "R", color: "text-[#75beff]" },
  C: { label: "C", color: "text-[#75beff]" },
  U: { label: "U", color: "text-[#f48771]" },
  "?": { label: "U", color: "text-[#4ec9b0]" },
};

export function GitPane({
  onOpenDiff,
}: {
  onOpenDiff: (path: string, staged: boolean) => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [expanded, setExpanded] = useState({ staged: true, changes: true });
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api("/api/git/status"));
      const data = (await res.json()) as GitStatus & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `${res.status}`);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  const call = async (url: string, body?: unknown) => {
    const res = await fetch(api(url), {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; output?: string };
    if (!res.ok) throw new Error(data.error ?? `${res.status}`);
    return data;
  };

  const stage = async (paths: string[]) => {
    try { await call("/api/git/stage", { paths }); await refresh(); }
    catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  };
  const unstage = async (paths: string[]) => {
    try { await call("/api/git/unstage", { paths }); await refresh(); }
    catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  };
  const discard = async (path: string) => {
    if (!confirm(`Discard changes to ${path}? This cannot be undone.`)) return;
    try { await call("/api/git/discard", { paths: [path] }); await refresh(); }
    catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  };

  const unstagedCombined = useMemo<GitFile[]>(() => {
    if (!status) return [];
    return [
      ...status.unstaged,
      ...status.untracked.map((p) => ({ path: p, status: "?" })),
    ];
  }, [status]);

  const commit = async () => {
    if (!message.trim() || !status || status.staged.length === 0) return;
    setCommitting(true);
    try {
      const data = await call("/api/git/commit", { message });
      flash(data.output ? data.output.split("\n")[0] : "Committed");
      setMessage("");
      await refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  };

  const stageAll = () => status && void stage(unstagedCombined.map((f) => f.path));
  const unstageAll = () => status && void unstage(status.staged.map((f) => f.path));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#858585]">
          Source Control
        </span>
        <button
          onClick={() => void refresh()}
          title="Refresh"
          className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {status && (
        <div className="mx-3 mb-2 flex items-center gap-1.5 rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[11px]">
          <GitBranch size={11} className="text-[#75beff]" />
          <span className="text-[#cccccc]">{status.branch}</span>
          {status.ahead > 0 && <span className="text-[#4ec9b0]">↑{status.ahead}</span>}
          {status.behind > 0 && <span className="text-[#f48771]">↓{status.behind}</span>}
        </div>
      )}

      {/* Commit box */}
      <div className="px-3 pb-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message (⌘↵ to commit)"
          rows={2}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          className="w-full resize-none rounded border border-[#3a3a3a] bg-[#1a1a1a] px-2 py-1.5 text-[12px] text-white placeholder:text-[#666] outline-none focus:border-[#0078d4]"
        />
        <button
          onClick={() => void commit()}
          disabled={!message.trim() || !status?.staged.length || committing}
          className="mt-1 flex w-full items-center justify-center gap-1 rounded bg-[#0078d4] py-1 text-[11px] font-medium text-white transition-colors hover:bg-[#0086ee] disabled:cursor-not-allowed disabled:bg-[#2a2a2a] disabled:text-[#666]"
        >
          <Check size={11} />
          Commit {status?.staged.length ? `(${status.staged.length})` : ""}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-3 mb-2 rounded border border-[#f4877140] bg-[#f4877120] px-2 py-1 text-[11px] text-[#f48771]">
          {error}
        </div>
      )}
      {toast && (
        <div className="mx-3 mb-2 truncate rounded border border-[#0078d440] bg-[#0078d420] px-2 py-1 text-[11px] text-[#75beff]">
          {toast}
        </div>
      )}

      {/* Lists */}
      <div className="flex-1 overflow-auto">
        {status && (
          <>
            <GroupHeader
              label={`Staged Changes (${status.staged.length})`}
              expanded={expanded.staged}
              onToggle={() => setExpanded((e) => ({ ...e, staged: !e.staged }))}
              actions={
                status.staged.length > 0
                  ? [{ icon: <Minus size={11} />, title: "Unstage all", onClick: unstageAll }]
                  : []
              }
            />
            {expanded.staged && status.staged.map((f) => (
              <FileRow
                key={`s::${f.path}`}
                file={f}
                onClick={() => onOpenDiff(f.path, true)}
                actions={[
                  { icon: <Minus size={11} />, title: "Unstage", onClick: () => void unstage([f.path]) },
                ]}
              />
            ))}

            <GroupHeader
              label={`Changes (${unstagedCombined.length})`}
              expanded={expanded.changes}
              onToggle={() => setExpanded((e) => ({ ...e, changes: !e.changes }))}
              actions={
                unstagedCombined.length > 0
                  ? [{ icon: <Plus size={11} />, title: "Stage all", onClick: stageAll }]
                  : []
              }
            />
            {expanded.changes && unstagedCombined.map((f) => (
              <FileRow
                key={`u::${f.path}`}
                file={f}
                onClick={() => onOpenDiff(f.path, false)}
                actions={[
                  f.status !== "?" && {
                    icon: <RotateCcw size={11} />,
                    title: "Discard changes",
                    onClick: () => void discard(f.path),
                  },
                  { icon: <Plus size={11} />, title: "Stage", onClick: () => void stage([f.path]) },
                ].filter(Boolean) as { icon: React.ReactNode; title: string; onClick: () => void }[]}
              />
            ))}

            {status.staged.length === 0 && unstagedCombined.length === 0 && (
              <div className="px-4 py-6 text-center text-[11px] text-[#666]">
                Working tree clean ✨
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GroupHeader({
  label,
  expanded,
  onToggle,
  actions,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  actions: { icon: React.ReactNode; title: string; onClick: () => void }[];
}) {
  return (
    <div className="group flex items-center gap-1 px-2 py-1 hover:bg-[#2a2a2a]">
      <button onClick={onToggle} className="flex flex-1 items-center gap-1 text-left">
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#858585]">
          {label}
        </span>
      </button>
      <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {actions.map((a, i) => (
          <button
            key={i}
            onClick={(e) => { e.stopPropagation(); a.onClick(); }}
            title={a.title}
            className="rounded p-0.5 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            {a.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

function FileRow({
  file,
  onClick,
  actions,
}: {
  file: GitFile;
  onClick: () => void;
  actions: { icon: React.ReactNode; title: string; onClick: () => void }[];
}) {
  const s = STATUS_LABEL[file.status] ?? { label: file.status, color: "text-[#858585]" };
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  return (
    <div
      className="group flex cursor-pointer items-center gap-1 px-2 py-[3px] pl-6 text-[12px] hover:bg-[#2a2a2a]"
      onClick={onClick}
      title={file.path}
    >
      <FileText size={11} className="shrink-0 text-[#858585]" />
      <span className="truncate text-[#cccccc]">{name}</span>
      <span className="truncate text-[11px] text-[#666]">{dir}</span>
      <div className="ml-auto flex items-center gap-0.5">
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {actions.map((a, i) => (
            <button
              key={i}
              onClick={(e) => { e.stopPropagation(); a.onClick(); }}
              title={a.title}
              className="rounded p-0.5 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
            >
              {a.icon}
            </button>
          ))}
        </div>
        <span className={`w-4 shrink-0 text-right font-mono text-[11px] ${s.color}`}>
          {s.label}
        </span>
      </div>
    </div>
  );
}
