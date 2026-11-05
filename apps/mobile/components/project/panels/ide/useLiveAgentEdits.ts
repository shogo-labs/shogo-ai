/**
 * useLiveAgentEdits — live agent-edit hook for the Workbench.
 *
 * Keeps open editors in sync with whatever the chat agent writes to disk,
 * Cursor-style. The hook runs three parallel sync mechanisms against the
 * agent workspace — belt, suspenders, and a pair of duct-tape:
 *
 *   1. SSE push (primary). Subscribes to `WorkspaceService.subscribe()` and
 *      applies each `file.changed` / `file.deleted` event immediately.
 *   2. Resync on (re)connect. Every time the stream opens — the first time and
 *      each reconnect — every open agent-tracked file is re-read (conditionally,
 *      so unchanged files cost a 304) to catch writes made while it was down.
 *   3. Polling fallback, only while the stream is down. One conditional read of
 *      the currently-active agent file every 15 s (30 s once the reconnect
 *      ladder is capped). With a healthy stream this hook makes no requests at
 *      all, and a hidden tab makes none either — that was ~28.8k proxied
 *      reads/day before PERF-10. Policy lives in `lib/stream-fallback`.
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
import type { WorkspaceFsEvent, WorkspaceService } from "./workspace/types";
import { upsertModelFromContent } from "./monaco/workspaceModels";
import { isBinaryFilePath } from "@shogo-ai/sdk/file-types";
import { appVisibility, createStreamFallback, POLL_INTERVAL_MS } from "../../../../lib/stream-fallback";

/** True when `path` should NOT be round-tripped through the text readFile
 *  API — reading it as utf-8 produces U+FFFD replacement chars and a
 *  subsequent autosave PUT would write those back, permanently bloating
 *  the on-disk file (~2x size, broken bytes). Canonical predicate lives
 *  in `@shogo-ai/core/file-types`; one source of truth across runtime,
 *  Workbench, live-edit sync, and the local FS layer. */
const isBinaryPath = isBinaryFilePath;

const AGENT_ROOT_ID = "agent";
const fileId = (rootId: string, path: string) => `${rootId}::${path}`;

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
   * still flow into the buffers), but the fallback poll only runs while the
   * user is actually looking at the Workbench. Defaults to `true` so callers
   * that don't care about visibility (tests, embedded uses) keep their
   * existing behaviour.
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

  /** Polling is gated on the pane being on screen; the stream is not. */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

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
  // Live edits: SSE push, a conditional poll only while the stream is down,
  // and one resync per (re)connect. The retry/poll policy is shared with the
  // runtime-log stream — see `lib/stream-fallback`.
  //
  // The subscription survives the IDE pane being off screen (the hook stays
  // mounted across tab switches and the buffers must keep up); only the
  // fallback poll is gated on `visible` and on the document being on screen.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    if (!service) return;

    let cancelled = false;
    const visibility = appVisibility();

    /** Open agent text tabs we may re-read. */
    const readableOpenFiles = (): string[] => {
      const paths = new Set<string>();
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
            paths.add(f.path);
          }
        }
      }
      return [...paths];
    };

    /**
     * Read a file, but only pay for the body when it actually changed: the
     * runtime answers a matching ETag with 304, which comes back as `null`.
     * Backends without a conditional read fall back to a plain `readFile`
     * (the content comparison in `applyIncoming` still no-ops it).
     */
    const readIfChanged = async (
      svc: WorkspaceService,
      path: string,
    ): Promise<{ content: string; mtime: number } | null> => {
      if (typeof svc.readFileIfChanged === "function") {
        const file = await svc.readFileIfChanged(path);
        return file ? { content: file.content, mtime: file.mtime } : null;
      }
      const file = await svc.readFile(path);
      return { content: file.content, mtime: file.mtime };
    };

    /**
     * Catch up every open agent file. Runs on the first connect and on every
     * reconnect, so writes made while the stream was down still land.
     */
    const resyncOpenFiles = async (): Promise<void> => {
      const svc = serviceRef.current;
      if (!svc) return;
      for (const path of readableOpenFiles()) {
        try {
          const changed = await readIfChanged(svc, path);
          if (cancelled || !changed) continue;
          applyIncomingRef.current(path, changed.content, changed.mtime, false);
          // Keep Monaco's background model in sync too, so cross-file
          // IntelliSense reflects what's on disk after a reconnect.
          upsertModelFromContent(AGENT_ROOT_ID, path, changed.content);
        } catch {
          /* transient — the poller or the next SSE event will retry */
        }
      }
    };

    /**
     * Fallback poll — the active file only, and only while the stream is down.
     * Polling every open tab would stampede reads on a large project.
     */
    const pollActiveFile = async (): Promise<void> => {
      if (!visibleRef.current) return;
      const svc = serviceRef.current;
      if (!svc) return;

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
        const changed = await readIfChanged(svc, active.path);
        if (cancelled || !changed) return;
        if (changed.content === active.content) return;
        applyIncomingRef.current(active.path, changed.content, changed.mtime, false);
      } catch {
        /* transient — next tick will retry */
      }
    };

    if (typeof service.subscribe !== "function") {
      // No live stream on this backend (local folders): the slow conditional
      // poll is the only source, and it costs one local read per tick. Park it
      // on a hidden tab like the streaming path does, and catch up on return.
      const visibility = appVisibility();
      const tick = (): void => {
        if (!visibility.isVisible()) return;
        void pollActiveFile();
      };
      const timer = setInterval(tick, POLL_INTERVAL_MS);
      const unsubscribeVisibility = visibility.subscribe(tick);
      return () => {
        cancelled = true;
        clearInterval(timer);
        unsubscribeVisibility();
      };
    }

    const handleEvent = (evt: WorkspaceFsEvent): void => {
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
    };

    const fallback = createStreamFallback({
      isVisible: visibility.isVisible,
      subscribeVisibility: visibility.subscribe,
      poll: pollActiveFile,
      connect: (hooks) =>
        service.subscribe!(handleEvent, {
          onStatus: (status) => {
            if (status === "open") {
              hooks.onOpen();
              // First open and every reconnect: pull whatever we missed.
              void resyncOpenFiles();
            } else {
              hooks.onError();
            }
          },
        }),
    });

    fallback.start();

    return () => {
      cancelled = true;
      fallback.stop();
    };
  }, [service, enabled, setGroups, setConflicts, refreshTree]);
}
