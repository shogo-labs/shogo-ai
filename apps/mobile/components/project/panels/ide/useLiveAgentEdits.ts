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
 *   • File not open + the event came from the agent (`source === "agent"`)
 *     + the "Follow agent edits" setting is on → auto-open in the active
 *     editor group. The tab is a normal tab; the user can close or pin it.
 *     It is only focused if the user hasn't typed/clicked in the IDE in the
 *     last USER_ACTIVE_WINDOW_MS and the active file has no unsaved edits;
 *     otherwise it opens as a background tab. Events from IDE saves or
 *     external processes never open tabs. (Push-only — polling never opens
 *     new tabs.)
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
import type { Dispatch, RefObject, SetStateAction } from "react";

import type { EditorGroup, OpenFile } from "./types";
import type { WorkspaceService } from "./workspace/types";
import { upsertModelFromContent } from "./monaco/workspaceModels";
import { isBinaryFilePath } from "@shogo-ai/sdk/file-types";

/** True when `path` should NOT be round-tripped through the text readFile
 *  API — reading it as utf-8 produces U+FFFD replacement chars and a
 *  subsequent autosave PUT would write those back, permanently bloating
 *  the on-disk file (~2x size, broken bytes). Canonical predicate lives
 *  in `@shogo-ai/core/file-types`; one source of truth across runtime,
 *  Workbench, live-edit sync, and the local FS layer. */
const isBinaryPath = isBinaryFilePath;

const AGENT_ROOT_ID = "agent";
const fileId = (rootId: string, path: string) => `${rootId}::${path}`;

/** How often to poll the active file for changes when SSE is flaky. */
const POLL_INTERVAL_MS = 2000;

/**
 * If the user typed or clicked inside the IDE within this window, an
 * auto-opened agent file is added as a background tab instead of being
 * focused.
 */
export const USER_ACTIVE_WINDOW_MS = 10_000;

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
  /** `path` = the file/dir that changed, so the host can refresh just its parent folder. */
  refreshTree: (path?: string) => void;
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
  /**
   * "Follow agent" (user setting, default true). When false, files the agent
   * edits are never auto-opened; already-open tabs still stay in sync.
   */
  followAgent?: boolean;
  /**
   * Element whose keyboard / pointer activity counts as "the user is working
   * in the IDE". Used to avoid switching tabs under the user's hands.
   */
  activityRootRef?: RefObject<HTMLElement | null>;
  /**
   * Whether the IDE pane is visible to the user. The hook stays mounted
   * across tab switches (the SSE subscription must survive so live edits
   * still flow into the buffers), but the 2s polling fallback only runs
   * while the user is actually looking at the Workbench. Defaults to
   * `true` so callers that don't care about visibility (tests, embedded
   * uses) keep their existing behaviour.
   */
  visible?: boolean;
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
  followAgent = true,
  activityRootRef,
  visible = true,
}: UseLiveAgentEditsArgs): void {
  const followAgentRef = useRef(followAgent);
  followAgentRef.current = followAgent;

  // Timestamp of the last keystroke / pointer press inside the IDE root.
  const lastUserActivityRef = useRef(0);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const mark = (e: Event) => {
      const root = activityRootRef?.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) return;
      lastUserActivityRef.current = Date.now();
    };
    document.addEventListener("keydown", mark, true);
    document.addEventListener("pointerdown", mark, true);
    return () => {
      document.removeEventListener("keydown", mark, true);
      document.removeEventListener("pointerdown", mark, true);
    };
  }, [activityRootRef]);

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
        const groupIdxForFocus = Math.min(
          Math.max(0, activeGroupIdxRef.current),
          next.length - 1,
        );
        const focusGroup = next[groupIdxForFocus];
        const activeInGroup = focusGroup?.files.find(
          (f) => f.id === focusGroup.activeId,
        );
        // Never yank the user's tab away while they're working: skip the
        // focus switch if they interacted with the IDE recently or the
        // active file has unsaved edits. The tab is still added so they
        // can find the agent's file.
        const stealFocus =
          !activeInGroup?.dirty &&
          Date.now() - lastUserActivityRef.current > USER_ACTIVE_WINDOW_MS;
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
                activeId: stealFocus ? id : g.activeId,
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
        // Skip image / video / audio / pdf / font / generic-binary tabs —
        // their content is either a blob: URL (preview tabs) or simply not
        // text, and running readFile() on them would corrupt the buffer
        // (binary → utf-8 decode produces U+FFFD replacement chars). For
        // preview tabs that would also clobber the blob: URL.
        if (
          f.rootId === AGENT_ROOT_ID &&
          !f.loading &&
          !f.error &&
          f.language !== "image" &&
          !isBinaryPath(f.path)
        ) {
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
          // Keep Monaco's background model in sync too, so cross-file
          // IntelliSense reflects what's on disk after a reconnect.
          upsertModelFromContent(AGENT_ROOT_ID, path, file.content);
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
        refreshTree(evt.path);
        return;
      }

      if (evt.type !== "file.changed") return;
      const { path, mtime } = evt;
      // file.changed on binary files (images / videos / audio / pdfs /
      // fonts / archives / sqlite / wasm / executables) must NOT round-trip
      // through the text readFile API. The agent-runtime's GET
      // `/agent/workspace/files/*` decodes bytes as utf-8 — for binary
      // files this produces U+FFFD replacement chars, and if the IDE's
      // autosave fires (debounced 1s after Monaco's onChange flips
      // dirty=true on the corrupted setValue), the PUT writes those
      // replacement chars back as utf-8, permanently bloating the file
      // on disk. Bail out before readFile runs.
      if (isBinaryPath(path)) return;

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
        // Refresh the background Monaco model so cross-file IntelliSense
        // (go-to-def, rename, imports) sees the agent's edit even when the
        // file isn't currently open in a tab. This used to happen via a
        // full `loadWorkspaceModels` re-walk inside `refreshTree`, which
        // burst hundreds of `readFile`s through agent-proxy on every edit.
        upsertModelFromContent(AGENT_ROOT_ID, path, content);
        // Only genuine agent edits may open new tabs. Events from the IDE's
        // own saves, external processes (`fs`) or older runtimes that don't
        // tag a source just refresh already-open tabs.
        const autoOpen = followAgentRef.current && evt.source === "agent";
        const touched = applyIncomingRef.current(path, content, mtime, autoOpen);
        if (touched) refreshTree(path);
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
  //
  // Skipped when the IDE pane is not visible. The Workbench stays mounted
  // (display:none) across tab switches so the SSE subscription survives,
  // but polling a hidden panel just floods the network tab with
  // GET /agent/workspace/files/<path> every 2s after the chat agent
  // edits a file. The SSE handler's initial-resync block already re-reads
  // every open agent file when the subscription (re)opens, which is enough
  // to catch up anything missed while polling was paused.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    if (!visible) return;
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
        active.dirty ||
        active.language === "image" ||
        isBinaryPath(active.path)
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
  }, [service, enabled, visible]);
}
