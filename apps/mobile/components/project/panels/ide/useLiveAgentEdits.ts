/**
 * useLiveAgentEdits — live agent-edit hook for the Workbench.
 *
 * Keeps open editors in sync with whatever the chat agent writes to disk,
 * Cursor-style. The hook runs three parallel sync mechanisms against the
 * agent workspace — belt, suspenders, and a pair of duct-tape:
 *
 *   1. SSE push (primary). Subscribes to `WorkspaceService.subscribe()` and
 *      applies each `file.changed` / `file.deleted` event immediately.
 *   2. Initial resync. When the subscription first opens (or the IDE tab
 *      re-mounts), every open agent-tracked file is re-read from disk so we
 *      catch anything written while the subscription was down.
 *   3. Polling fallback. Every `POLL_INTERVAL_MS` we re-read the currently-
 *      active agent file and apply any diff. This is the safety net for
 *      environments where SSE is proxied through infra that buffers or drops
 *      the stream (ngrok, some CDNs, aggressive corporate proxies).
 *
 * Per-file behaviour is identical across all three paths:
 *
 *   • File not open + clean state → auto-open in the active editor group
 *     ("follow agent"). The tab is a normal tab; the user can close or pin it.
 *     (Push-only — polling never opens new tabs.)
 *   • File open + no unsaved edits → replace buffer content. If the file is
 *     the one the user is looking at, run the Cursor-style green-flash +
 *     typewriter animation; otherwise swap silently.
 *   • File open + local unsaved edits → DO NOT overwrite. Stash the incoming
 *     version as a LiveConflict; the Workbench renders <AgentEditBanner> so
 *     the user can Reload or Keep mine.
 *   • File deleted → mark the open tab as deleted (read-only error state);
 *     tree is refreshed so it disappears from the sidebar.
 *
 * Only the agent root is touched — local folders never emit events and are
 * never polled.
 */

import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { EditorGroup, OpenFile } from "./types";
import type { WorkspaceService } from "./workspace/types";

const AGENT_ROOT_ID = "agent";
const fileId = (rootId: string, path: string) => `${rootId}::${path}`;

/** How often to poll the active file for changes when SSE is flaky. */
const POLL_INTERVAL_MS = 2000;

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
  /** Current groups (read-only snapshot; kept fresh via ref internally). */
  groups: EditorGroup[];
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
 * Installs the live-edit SSE subscription + polling fallback. Cleans up on
 * unmount / service change. No-ops on backends without `.subscribe` (e.g.
 * LocalFs) — those only get the polling fallback on open tabs, and only if
 * they have `readFile`.
 */
export function useLiveAgentEdits({
  service,
  setGroups,
  groups,
  activeGroupIdx,
  conflicts,
  setConflicts,
  refreshTree,
  tryAnimate,
  enabled = true,
}: UseLiveAgentEditsArgs): void {
  // Keep refs to the latest values so handlers closed over at subscribe time
  // read fresh state without us retearing the subscription on every render.
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;

  const activeGroupIdxRef = useRef(activeGroupIdx);
  activeGroupIdxRef.current = activeGroupIdx;

  const tryAnimateRef = useRef(tryAnimate);
  tryAnimateRef.current = tryAnimate;

  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const serviceRef = useRef(service);
  serviceRef.current = service;

  /**
   * Apply an incoming content update for `path` to the open-tab state.
   * Used by the SSE push handler, the initial resync, and the poller.
   *
   * `autoOpen` controls whether an unknown-to-the-editor path should be
   * auto-opened in the active group. Push events opt in (that's the "follow
   * agent" UX); polling opts out (we'd race with the user closing tabs).
   */
  const applyIncoming = useCallback(
    (path: string, content: string, mtime: number, autoOpen: boolean) => {
      const id = fileId(AGENT_ROOT_ID, path);

      // Dedupe: if an identical conflict is already queued, nothing to do.
      if (
        conflictsRef.current.some(
          (c) => c.fileId === id && c.incomingContent === content,
        )
      ) {
        return false;
      }

      let didTouch = false;

      setGroups((prev) => {
        let touched = false;
        let hadDirtyDiff = false;

        const next = prev.map((g) => ({
          ...g,
          files: g.files.map((f) => {
            if (f.id !== id) return f;
            touched = true;
            if (f.content === content) {
              return { ...f, savedContent: content, dirty: false };
            }
            if (f.dirty) {
              hadDirtyDiff = true;
              return f;
            }
            const animated = tryAnimateRef.current?.(f.id, content) ?? false;
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
          didTouch = true;
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

        if (!autoOpen) return next;

        // Not open anywhere → auto-open in the active group (follow agent).
        didTouch = true;
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

      return didTouch;
    },
    [setGroups, setConflicts],
  );

  const applyIncomingRef = useRef(applyIncoming);
  applyIncomingRef.current = applyIncoming;

  // -----------------------------------------------------------------------
  // SSE push subscription
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    if (!service || typeof service.subscribe !== "function") return;

    let cancelled = false;

    // Initial resync: re-read every currently-open agent file in case writes
    // happened while the subscription was down (e.g. user just switched to
    // the IDE tab, or the SSE connection was briefly interrupted).
    const openAgentFiles = new Set<string>();
    for (const g of groupsRef.current) {
      for (const f of g.files) {
        if (f.rootId === AGENT_ROOT_ID && !f.loading && !f.error) {
          openAgentFiles.add(f.path);
        }
      }
    }
    for (const path of openAgentFiles) {
      void (async () => {
        try {
          const file = await service.readFile(path);
          if (cancelled) return;
          applyIncomingRef.current(path, file.content, file.mtime, false);
        } catch {
          /* transient — poller or next SSE event will retry */
        }
      })();
    }

    const dispose = service.subscribe((evt) => {
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

      void (async () => {
        const svc = serviceRef.current;
        if (!svc) return;
        // Dedupe: if the same mtime is already queued as a conflict, skip
        // the refetch entirely.
        const id = fileId(AGENT_ROOT_ID, path);
        if (
          conflictsRef.current.some(
            (c) => c.fileId === id && c.incomingMtime === mtime,
          )
        ) {
          return;
        }

        let content: string;
        try {
          const file = await svc.readFile(path);
          content = file.content;
        } catch {
          return;
        }
        const touched = applyIncomingRef.current(path, content, mtime, true);
        if (touched) refreshTree();
      })();
    });

    return () => {
      cancelled = true;
      try { dispose(); } catch { /* best effort */ }
    };
  }, [service, enabled, setGroups, setConflicts, refreshTree]);

  // -----------------------------------------------------------------------
  // Polling fallback — checks the currently-active agent file every
  // POLL_INTERVAL_MS. Catches writes the SSE stream drops (proxies that
  // buffer SSE, corporate firewalls, temporary network blips).
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    if (!service) return;

    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      const svc = serviceRef.current;
      if (!svc) return;

      // Only poll the currently-active file; polling every open tab would
      // stampede `readFile` on a large project. The active file is what the
      // user is actually looking at, so it's what matters for "see live".
      const gs = groupsRef.current;
      const activeGroup = gs[Math.min(Math.max(0, activeGroupIdxRef.current), gs.length - 1)];
      const active = activeGroup?.files.find((f) => f.id === activeGroup.activeId);
      if (
        !active ||
        active.rootId !== AGENT_ROOT_ID ||
        active.loading ||
        active.error ||
        active.dirty
      ) {
        return;
      }

      try {
        const file = await svc.readFile(active.path);
        if (stopped) return;
        if (file.content === active.content) return;
        applyIncomingRef.current(active.path, file.content, file.mtime, false);
      } catch {
        /* transient — next tick will retry */
      }
    };

    const interval = window.setInterval(() => { void tick() }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [service, enabled]);
}
