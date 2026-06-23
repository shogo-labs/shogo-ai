import { ArrowDown, ArrowUp, Check, ExternalLink, GitBranch, Loader2, RefreshCw } from "lucide-react-native";
import { useState } from "react";

import { BranchPicker } from "./git/BranchPicker";
import type { GitSnapshot } from "./git/bridge";
import type { ExtensionRuntimeStatusBarItem } from "./extensions/types";
import { getDesktopGitBridge } from "./git/bridge";
import { isDesktopRuntime } from "./terminal/pty-factory";

export function StatusBar({
  language,
  line,
  col,
  saved,
  git,
  workspaceRoot,
  extensionItems = [],
  onRunExtensionCommand,
  onOpenCodeWorkbench,
}: {
  language: string;
  line: number;
  col: number;
  saved: boolean;
  /**
   * Optional git snapshot for the active workspace. Provided by Workbench
   * on desktop via `useGitStatus`. On web/mobile this prop stays null /
   * undefined and the segment isn't rendered.
   */
  git?: GitSnapshot | null;
  /**
   * Absolute workspace root — needed for the click-to-pick branch
   * overlay and the sync button. Null on web/mobile.
   */
  workspaceRoot?: string | null;
  extensionItems?: ExtensionRuntimeStatusBarItem[];
  onRunExtensionCommand?: (commandId: string, args?: unknown[]) => void;
  onOpenCodeWorkbench?: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const bridge = getDesktopGitBridge();
  const canOpenCodeWorkbench = !!onOpenCodeWorkbench && isDesktopRuntime();
  const handleSync = async () => {
    if (!bridge || !workspaceRoot) return;
    setSyncing(true);
    setSyncError(null);
    const r = await bridge.remotes.sync(workspaceRoot, {});
    setSyncing(false);
    if (!r.ok) setSyncError(r.error ?? r.reason ?? "sync failed");
    // Auto-clear the error after 6 seconds so the bar doesn't get stuck.
    if (!r.ok) setTimeout(() => setSyncError(null), 6000);
  };

  const leftExtensionItems = extensionItems.filter((item) => item.alignment !== "right");
  const rightExtensionItems = extensionItems.filter((item) => item.alignment === "right");

  return (
    <div className="flex h-6 items-center justify-between gap-3 bg-[#1e1e1e] px-3 text-[12px] text-[#cccccc]">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        {git?.isRepo && git.branch ? (
          <>
            <button
              onClick={() => setPickerOpen(true)}
              title={
                git.upstream
                  ? `Tracking ${git.upstream}${git.ahead || git.behind ? ` · ${git.ahead} ahead, ${git.behind} behind` : ""} · click to change branch`
                  : "No upstream · click to change branch"
              }
              className="-mx-1 flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-white/15"
            >
              <GitBranch size={12} />
              <span className="max-w-[150px] truncate sm:max-w-[220px]">{git.detached ? "HEAD detached" : git.branch}</span>
              {git.ahead > 0 && (
                <span className="flex items-center gap-0.5 opacity-80">
                  <ArrowUp size={10} />
                  {git.ahead}
                </span>
              )}
              {git.behind > 0 && (
                <span className="flex items-center gap-0.5 opacity-80">
                  <ArrowDown size={10} />
                  {git.behind}
                </span>
              )}
            </button>
            <button
              onClick={handleSync}
              disabled={syncing || !workspaceRoot}
              title="Sync (fetch · pull · push)"
              className="flex items-center gap-1 -mx-1 px-1 py-0.5 rounded hover:bg-white/15 disabled:opacity-60"
            >
              {syncing ? <Loader2 size={11} /> : <RefreshCw size={11} />}
            </button>
            {syncError && (
              <span className="text-[10px] bg-rose-500/30 px-1.5 py-0.5 rounded max-w-[280px] truncate" title={syncError}>
                {syncError}
              </span>
            )}
          </>
        ) : null}
        {canOpenCodeWorkbench ? (
          <button
            type="button"
            onClick={onOpenCodeWorkbench}
            title="Open or focus Shogo IDE"
            aria-label="Open or focus Shogo IDE"
            className="-mx-1 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-orange-400 hover:bg-white/15 hover:text-orange-300"
          >
            <ExternalLink size={11} />
            <span className="hidden sm:inline">Shogo IDE</span>
          </button>
        ) : null}
        {leftExtensionItems.map((item) => (
          <ExtensionStatusBarButton key={item.id} item={item} onRunCommand={onRunExtensionCommand} />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {rightExtensionItems.map((item) => (
          <ExtensionStatusBarButton key={item.id} item={item} onRunCommand={onRunExtensionCommand} />
        ))}
        <span>
          Ln {line}, Col {col}
        </span>
        <span>{language}</span>
        <span>UTF-8</span>
        <span className="flex items-center gap-1">
          {saved ? <Check size={12} /> : <Circle />}
          {saved ? "Saved" : "Unsaved"}
        </span>
      </div>
      {pickerOpen && workspaceRoot && git?.branch !== undefined && (
        <BranchPicker
          workspaceRoot={workspaceRoot}
          currentBranch={git.branch}
          onClose={() => setPickerOpen(false)}
          onChanged={() => {
            // Snapshot will refresh on its own via the 5s poll +
            // service refresh; nothing else to do here.
          }}
        />
      )}
    </div>
  );
}

function Circle() {
  return <span className="inline-block h-2 w-2 rounded-full bg-white/80" />;
}


function ExtensionStatusBarButton({
  item,
  onRunCommand,
}: {
  item: ExtensionRuntimeStatusBarItem;
  onRunCommand?: (commandId: string, args?: unknown[]) => void;
}) {
  const command = typeof item.command === "string" ? { command: item.command, arguments: [] } : item.command;
  const runnable = !!command?.command && !!onRunCommand;
  return (
    <button
      type="button"
      disabled={!runnable}
      title={item.tooltip || item.text || item.extensionId}
      onClick={() => command?.command && onRunCommand?.(command.command, command.arguments)}
      className="-mx-1 max-w-[220px] truncate rounded px-1 py-0.5 hover:bg-white/15 disabled:pointer-events-none disabled:opacity-90"
    >
      {stripCodicons(item.text)}
    </button>
  );
}

function stripCodicons(text: string): string {
  return text.replace(/\$\(([^)]+)\)/g, (_match, icon) => `${String(icon).replace(/-/g, " ")} `).trim();
}
