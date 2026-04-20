/**
 * useLiveAgentEdits — live agent-edit hook for the Workbench.
 *
 * Subscribes to the agent workspace's file-level SSE stream (see
 * WorkspaceService.subscribe) and keeps open editors in sync with whatever
 * the chat agent writes to disk, Cursor-style:
 *
 *   • File not open + clean state → auto-open in the active editor group
 *     ("follow agent"). The tab is a normal tab; the user can close or pin it.
 *   • File open + no unsaved edits → replace buffer content (Monaco applies
 *     a minimal edit and preserves cursor/scroll automatically because
 *     @monaco-editor/react diffs the `value` prop).
 *   • File open + local unsaved edits → DO NOT overwrite. Stash the incoming
 *     version as a LiveConflict; the Workbench renders <AgentEditBanner> so
 *     the user can Reload or Keep mine.
 *   • File deleted → mark the open tab as deleted (read-only error state);
 *     tree is refreshed so it disappears from the sidebar.
 *
 * Only the agent root emits events — local folders are never touched here.
 * The server only fires file.* events for writes done inside the agent
 * runtime (gateway-tools), so IDE saves do NOT echo back. No mtime stash
 * needed.
 */

import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { EditorGroup, OpenFile } from "./types";
import type { WorkspaceService } from "./workspace/types";

const AGENT_ROOT_ID = "agent";
const fileId = (rootId: string, path: string) => `${rootId}::${path}`;

function languageFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    py: "python",
    go: "go",
    rs: "rust",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sql: "sql",
  };
  return map[ext] ?? "plaintext";
}

export interface LiveConflict {
  fileId: string;
  path: string;
  incomingContent: string;
  incomingMtime: number;
}

export interface UseLiveAgentEditsArgs {
  /** The agent workspace service. Undefined = feature disabled. */
  service: WorkspaceService | undefined;
  setGroups: Dispatch<SetStateAction<EditorGroup[]>>;
  activeGroupIdx: number;
  conflicts: LiveConflict[];
  setConflicts: Dispatch<SetStateAction<LiveConflict[]>>;
  /** Called after changes so the sidebar tree reflects new/removed files. */
  refreshTree: () => void;
  /**
   * Attempt to apply `newContent` to the currently-visible editor with
   * Cursor-style animation (green flash + auto-scroll + optional typewriter).
   * Returns `true` if the animation took ownership of the content update, in
   * which case the hook only needs to update savedContent/dirty in state —
   * Monaco's onChange will flow the new content back into React.
   */
  tryAnimate?: (fileId: string, newContent: string) => boolean;
  /** Master switch (user setting). Default true. */
  enabled?: boolean;
}

/**
 * Installs the live-edit SSE subscription. Cleans up on unmount /
 * service change. No-ops on backends without `.subscribe` (e.g. LocalFs).
 */
export function useLiveAgentEdits({
  service,
  setGroups,
  activeGroupIdx,
  conflicts,
  setConflicts,
  refreshTree,
  tryAnimate,
  enabled = true,
}: UseLiveAgentEditsArgs): void {
  // Keep refs to the latest values so the SSE handler (closed over at
  // subscription time) reads fresh state without us retearing the
  // subscription on every render.
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;

  const activeGroupIdxRef = useRef(activeGroupIdx);
  activeGroupIdxRef.current = activeGroupIdx;

  const tryAnimateRef = useRef(tryAnimate);
  tryAnimateRef.current = tryAnimate;

  useEffect(() => {
    if (!enabled) return;
    if (!service || typeof service.subscribe !== "function") {
      console.log('[LIVE] useLiveAgentEdits: skipping subscribe', { enabled, hasService: !!service, hasSubscribe: !!service?.subscribe });
      return;
    }
    console.log('[LIVE] useLiveAgentEdits: installing subscription on service', service.id);

    console.log("[ShogoLive] subscribing to workspace stream");
    const dispose = service.subscribe((evt) => {
      console.log("[ShogoLive] event:", evt);
      console.log('[LIVE] hook received event', evt);
      if (evt.type === "file.deleted") {
        const id = fileId(AGENT_ROOT_ID, evt.path);
        setGroups((prev) =>
          prev.map((g) => ({
            ...g,
            files: g.files.map((f) =>
              f.id === id
                ? {
                    ...f,
                    loading: false,
                    dirty: false,
                    error: "File deleted by agent",
                  }
                : f,
            ),
          })),
        );
        setConflicts((cs) => cs.filter((c) => c.fileId !== id));
        refreshTree();
        return;
      }

      if (evt.type !== "file.changed") return;
      const { path, mtime } = evt;
      const id = fileId(AGENT_ROOT_ID, path);
      console.log("[ShogoLive] file.changed fileId=", id);

      void (async () => {
        // Dedupe: if the same mtime is already queued as a conflict, skip
        // the refetch.
        if (
          conflictsRef.current.some(
            (c) => c.fileId === id && c.incomingMtime === mtime,
          )
        ) {
          return;
        }

        let content: string;
        try {
          const file = await service.readFile(path);
          content = file.content;
        } catch {
          // Transient read error — next event or user click will recover.
          return;
        }

        setGroups((prev) => {
          let touched = false;
          let hadDirtyDiff = false;

          const next = prev.map((g) => ({
            ...g,
            files: g.files.map((f) => {
              if (f.id !== id) return f;
              touched = true;
              if (f.content === content) {
                // Already in sync — ensure dirty flag is correct.
                return { ...f, savedContent: content, dirty: false };
              }
              if (f.dirty) {
                hadDirtyDiff = true;
                return f;
              }
              // Try to animate the edit in the active editor. If it takes
              // ownership (returns true), leave `content` alone — Monaco's
              // onChange will flow the new text back through React. We only
              // update savedContent so the tab stays non-dirty.
              const animated =
                tryAnimateRef.current?.(f.id, content) ?? false;
              console.log('[LIVE] applying to open tab', { id: f.id, dirty: f.dirty, animated });
              if (animated) {
                return {
                  ...f,
                  savedContent: content,
                  dirty: false,
                  loading: false,
                  error: undefined,
                };
              }
              return {
                ...f,
                content,
                savedContent: content,
                dirty: false,
                loading: false,
                error: undefined,
              };
            }),
          }));

          if (touched) {
            if (hadDirtyDiff) {
              setConflicts((cs) => {
                const existing = cs.find((c) => c.fileId === id);
                if (existing) {
                  return cs.map((c) =>
                    c.fileId === id
                      ? { ...c, incomingContent: content, incomingMtime: mtime }
                      : c,
                  );
                }
                return [
                  ...cs,
                  { fileId: id, path, incomingContent: content, incomingMtime: mtime },
                ];
              });
            }
            return next;
          }

          // Not open anywhere → auto-open in the active group (follow agent).
          const name = path.split("/").pop() ?? path;
          const openFile: OpenFile = {
            id,
            rootId: AGENT_ROOT_ID,
            name,
            path,
            language: languageFor(path),
            content,
            savedContent: content,
            dirty: false,
          };
          const groupIdx = Math.min(
            Math.max(0, activeGroupIdxRef.current),
            next.length - 1,
          );
          return next.map((g, i) =>
            i === groupIdx
              ? {
                  ...g,
                  files: g.files.some((f) => f.id === id)
                    ? g.files
                    : [...g.files, openFile],
                  activeId: id,
                }
              : g,
          );
        });

        refreshTree();
      })();
    });

    return () => {
      try {
        dispose();
      } catch {
        /* best effort */
      }
    };
  }, [service, enabled, setGroups, setConflicts, refreshTree]);
}
