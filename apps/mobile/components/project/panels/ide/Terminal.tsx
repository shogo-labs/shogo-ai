// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  Square,
  Trash2,
  AlertTriangle,
  Loader2,
  Plus,
  X,
  ChevronDown,
} from "lucide-react-native";
import { API_URL } from "../../../../lib/api";
import { agentFetch } from "../../../../lib/agent-fetch";
import { readTerminalError } from "./terminal/error-reader";
import {
  createPtyClient,
  createPtyClientSession,
  isDesktopRuntime,
  type PtyClientLike,
} from "./terminal/pty-factory";
import { XtermView, type XtermViewHandle } from "./terminal/XtermView";
import {
  addSession as addSessionToList,
  addSplit as addSplitToList,
  closeGroup as closeGroupInList,
  closeSession as closeSessionInList,
  groupIdsOf,
  labelsFor,
  makeSession,
  patchSession as patchSessionInList,
  sessionsInGroup,
  type Session,
} from "./terminal/session-reducer";
import { TerminalHeader } from "./terminal/TerminalHeader";
import { useShellName } from "./terminal/useShellName";

/**
 * The IDE "Terminal" — a real PTY-backed shell, one per tab.
 *
 * Architecture (per tab):
 *   1. POST /api/projects/:projectId/terminal/sessions      → server allocates
 *      a long-lived PTY shell against the project's workspace dir.
 *   2. Open WebSocket /api/projects/:projectId/terminal/sessions/:id/ws
 *      (handled by `PtyClient`) for bidirectional bytes.
 *   3. Mount `XtermView`, which embeds `xterm.js` and wires its keystrokes
 *      to `client.send()` / its `onResize` to `client.resize()` /
 *      incoming bytes to `term.write()`.
 *
 * What we deliberately moved off the React tree:
 *   - Output buffering, history walking, prompt echo: these are now the
 *     real shell's job (the user IS typing into bash). xterm.js owns the
 *     scrollback + selection + ANSI rendering.
 *   - CWD tracking + `cd` simulation: a real PTY is a single persistent
 *     process; `cd` survives because it's the same shell.
 *   - Cancel-via-AbortController on a streamed HTTP response: the Stop
 *     button now sends SIGINT to the PTY (`client.signal('INT')`), which
 *     is what Ctrl-C does in any real terminal.
 *
 * Multi-tab UX kept identical to before:
 *   - Positional labels ("Terminal 1", "Terminal 2", …) via labelsFor()
 *     so closing a middle tab doesn't leave gaps.
 *   - Closing the *last* tab dismisses the bottom panel via onRequestClose
 *     (matches the original "X = hide the whole thing" intent).
 *
 * Preset commands (the kebab menu): we still expose them, but instead of
 * a separate /terminal/exec stream, we type the command into the active
 * shell — `client.send(command + '\r')`. That preserves the full PTY
 * experience (color, progress bars, signal handling) and shares state
 * with whatever the user has typed.
 *
 * Hidden tabs stay mounted (just `display: none`) so an unfocused shell
 * keeps streaming and the scrollback is still there when you switch back.
 */

interface PresetCommandDto {
  id: string;
  label: string;
  description: string;
  category: string;
  dangerous: boolean;
  /** Server-supplied raw shell snippet to type into the PTY. */
  command?: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  package: "Package",
  database: "Database",
  server: "Server",
  test: "Test",
  build: "Build",
  lint: "Lint",
};

const CATEGORY_ORDER: string[] = ["package", "database", "test", "build", "lint", "server"];

interface CreateSessionResponse {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
}

/**
 * Approximate character cell metrics for our 13px Menlo font with
 * line-height 1.2. Used to compute initial PTY cols/rows from the
 * container's pixel size *before* xterm.js mounts, so the shell starts
 * at roughly the right width and `zsh`'s PROMPT_SP padding doesn't
 * wrap weirdly across the first few lines. The exact size is corrected
 * on the first FitAddon-driven `resize()` after mount.
 */
const APPROX_CELL_WIDTH_PX = 7.8;
const APPROX_CELL_HEIGHT_PX = 13 * 1.2 + 2; // fontSize * lineHeight + a little padding

function estimateGridSize(el: HTMLElement | null): { cols: number; rows: number } {
  // Sane fallbacks for the brief window between mount and the first
  // layout pass (clientWidth = 0 inside React's commit phase).
  if (!el || el.clientWidth < 32 || el.clientHeight < 16) {
    return { cols: 80, rows: 24 };
  }
  const cols = Math.max(20, Math.floor(el.clientWidth / APPROX_CELL_WIDTH_PX));
  const rows = Math.max(4, Math.floor(el.clientHeight / APPROX_CELL_HEIGHT_PX));
  return { cols, rows };
}

/**
 * Translate the API base URL into the matching ws://… or wss://…
 * scheme. We keep the host + port (so localhost dev keeps hitting the
 * Bun server on 8002) and only swap the protocol prefix.
 */

function displayCwd(cwd: string | null | undefined): string {
  if (!cwd) return "~";
  const home = typeof process !== "undefined" ? process.env.HOME : undefined;
  let v = cwd;
  if (home && v.startsWith(home)) v = `~${v.slice(home.length) || ""}`;
  return v;
}

function cwdBasename(cwd: string | null | undefined): string {
  const v = displayCwd(cwd);
  if (v === "~") return "~";
  const parts = v.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? v;
}

function wsBaseFromApi(apiBase: string): string {
  if (apiBase.startsWith("https://")) return "wss://" + apiBase.slice("https://".length);
  if (apiBase.startsWith("http://")) return "ws://" + apiBase.slice("http://".length);
  // Fallback for protocol-less URLs (shouldn't happen in practice).
  return apiBase;
}

export function Terminal({
  projectId,
  visible,
  newSessionNonce,
  onRequestClose,
}: {
  projectId: string | null | undefined;
  visible: boolean;
  /** Parent increments this to request a new terminal (keyboard ⌘⇧`). */
  newSessionNonce?: number;
  /**
   * Called when the user closes the last remaining terminal session. The
   * parent should hide the bottom panel in response.
   */
  onRequestClose?: () => void;
}) {
  const [commands, setCommands] = useState<Record<string, PresetCommandDto[]>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>(() => [makeSession()]);
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id ?? "t0");
  const [confirming, setConfirming] = useState<PresetCommandDto | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // One imperative xterm handle per session, populated once XtermView mounts.
  const xtermRefs = useRef(new Map<string, XtermViewHandle | null>());
  // Pixel-size source of truth for `estimateGridSize`. We measure this
  // once *before* POST so the server-side PTY can spawn at roughly the
  // visible grid — preventing the visible PROMPT_SP wrap that zsh prints
  // when the panel turns out to be narrower than the default 80 cols.
  const panelRef = useRef<HTMLDivElement | null>(null);

  const apiBase = API_URL;
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const labels = useMemo(() => labelsFor(sessions), [sessions]);
  // Tabs are groups; ordered group ids drive both the tab strip and the
  // group-at-a-time layout below.
  const groupIds = useMemo(() => groupIdsOf(sessions), [sessions]);
  const activeGroupId = active?.groupId ?? "";

  const patchSession = useCallback((id: string, patch: (s: Session) => Session) => {
    setSessions((prev) => patchSessionInList(prev, id, patch));
  }, []);

  // ─── Server-side PTY lifecycle ──────────────────────────────────────
  // Provision a server PTY and wire up a PtyClient. We keep the
  // tab-bookkeeping (`Session`) and the underlying `PtyClient` 1:1; the
  // client is created exactly once per server session and shared with
  // XtermView via the session record.
  const provisionSession = useCallback(
    async (sessionId: string) => {
      if (!projectId) return;
      try {
        const initial = estimateGridSize(panelRef.current);
        let data: CreateSessionResponse;
        let client: PtyClientLike;
        if (isDesktopRuntime()) {
          const provisioned = await createPtyClientSession({
            spawn: {
              projectId,
              cols: initial.cols,
              rows: initial.rows,
            },
          });
          data = provisioned.session;
          client = provisioned.client;
        } else {
          const res = await agentFetch(
            `${apiBase}/api/projects/${projectId}/terminal/sessions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cols: initial.cols, rows: initial.rows }),
            },
          );
          if (!res.ok) {
            throw await readTerminalError(res, `HTTP ${res.status}`);
          }
          data = (await res.json()) as CreateSessionResponse;
          const wsUrl = `${wsBaseFromApi(apiBase)}/api/projects/${projectId}/terminal/sessions/${data.id}/ws`;
          client = await createPtyClient({ url: wsUrl, sessionId: data.id });
        }
        // Listeners attached *before* connect() so we don't miss the
        // first DATA / state transitions delivered synchronously by the
        // browser's WebSocket.
        client.onState((state) => {
          if (state === "open") {
            patchSession(sessionId, (s) =>
              s.status === "ready" ? s : { ...s, status: "ready", errorMessage: null },
            );
          }
        });
        client.onExit((info) => {
          patchSession(sessionId, (s) => ({
            ...s,
            status: "closed",
            exit: info,
          }));
        });
        client.onError((err) => {
          patchSession(sessionId, (s) =>
            s.status === "ready" ? s : { ...s, errorMessage: err.message },
          );
        });
        client.connect();
        patchSession(sessionId, (s) => ({
          ...s,
          ptySessionId: data.id,
          cwd: data.cwd ?? s.cwd ?? null,
          client,
          // Stay in "creating" until WS opens; we flip to "ready" in
          // onState above so the UI can show a "connecting…" hint until
          // the shell is actually live.
          errorMessage: null,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        patchSession(sessionId, (s) => ({
          ...s,
          status: "error",
          errorMessage: msg,
        }));
      }
    },
    [apiBase, projectId, patchSession],
  );

  /**
   * Tear down a single tab on the client *and* on the server. Best-
   * effort DELETE — if it fails (server already reaped the session,
   * network blip, …) the server will GC it on idle anyway. We still
   * dispose() the client so the WebSocket closes immediately.
   */
  const disposeSession = useCallback(
    (s: Session) => {
      try { s.client?.dispose() } catch {}
      xtermRefs.current.delete(s.id);
      if (projectId && s.ptySessionId && !isDesktopRuntime()) {
        // Fire-and-forget; don't await in the React close path.
        void agentFetch(
          `${apiBase}/api/projects/${projectId}/terminal/sessions/${s.ptySessionId}`,
          { method: "DELETE" },
        ).catch(() => {});
      }
    },
    [apiBase, projectId],
  );

  // Provision the *initial* session once on first mount (per project).
  // Subsequent sessions provision themselves inside `addSession`.
  //
  // Gated on `visible` so we don't allocate a server PTY (and measure a
  // hidden, zero-width panel) before the user has actually opened the
  // bottom drawer. React effects run after layout, so by the time this
  // fires `panelRef.current.clientWidth` is the real on-screen width
  // and `estimateGridSize` returns sensible cols/rows.
  const provisionedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!projectId) return;
    if (!visible) return;
    for (const s of sessionsRef.current) {
      if (s.ptySessionId || s.client) continue;
      if (provisionedRef.current.has(s.id)) continue;
      provisionedRef.current.add(s.id);
      void provisionSession(s.id);
    }
  }, [projectId, visible, provisionSession, sessions]);

  // ─── Preset commands (kebab menu) ───────────────────────────────────
  const loadCommands = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await agentFetch(`${apiBase}/api/projects/${projectId}/terminal/commands`);
      if (!res.ok) {
        throw await readTerminalError(res, `HTTP ${res.status}`);
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw await readTerminalError(res, "Terminal commands endpoint returned a non-JSON response");
      }
      const json = (await res.json()) as { commands: Record<string, PresetCommandDto[]> };
      setCommands(json.commands ?? {});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiBase, projectId]);

  // Same load-once guard as before — staging proxies sometimes 503 while
  // a runtime pod cold-starts; we don't want to hammer them.
  const loadAttemptedRef = useRef(false);
  useEffect(() => {
    if (!visible) return;
    if (!projectId) return;
    if (loadAttemptedRef.current) return;
    if (loading) return;
    loadAttemptedRef.current = true;
    void loadCommands();
  }, [visible, projectId, loading, loadCommands]);

  // Re-fetch presets when the project changes.
  useEffect(() => {
    loadAttemptedRef.current = false;
  }, [projectId]);

  // ─── Session add / split / close ────────────────────────────────────
  // "New Terminal": a fresh group → its own tab, rendered as a single pane.
  const addSession = useCallback(() => {
    const s = makeSession();
    setSessions((prev) => addSessionToList(prev, s));
    setActiveId(s.id);
    if (projectId) {
      provisionedRef.current.add(s.id);
      void provisionSession(s.id);
    }
  }, [projectId, provisionSession]);

  // "Split Terminal": a new pane inside the active session's group → shown
  // side-by-side within the current tab.
  const splitSession = useCallback(() => {
    const current =
      sessionsRef.current.find((x) => x.id === activeIdRef.current) ??
      sessionsRef.current[0];
    const s = makeSession(current?.groupId);
    setSessions((prev) => addSplitToList(prev, s));
    setActiveId(s.id);
    if (projectId) {
      provisionedRef.current.add(s.id);
      void provisionSession(s.id);
    }
  }, [projectId, provisionSession]);

  const closeSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const sess = prev.find((x) => x.id === id);
        if (sess) disposeSession(sess);
        const result = closeSessionInList(prev, id, activeId);
        if (result.panelDismissed) {
          onRequestClose?.();
          // Reset to a single fresh tab so the next reopen starts clean.
          const fresh = makeSession();
          queueMicrotask(() => {
            setActiveId(fresh.id);
            if (projectId) {
              provisionedRef.current.add(fresh.id);
              void provisionSession(fresh.id);
            }
          });
          return [fresh];
        }
        if (result.nextActiveId) {
          const next = result.nextActiveId;
          queueMicrotask(() => setActiveId(next));
        }
        return result.sessions;
      });
    },
    [activeId, disposeSession, onRequestClose, projectId, provisionSession],
  );

  // Close a whole tab (every split pane in the group).
  const closeGroup = useCallback(
    (groupId: string) => {
      setSessions((prev) => {
        prev
          .filter((s) => s.groupId === groupId)
          .forEach((s) => disposeSession(s));
        const result = closeGroupInList(prev, groupId, activeIdRef.current);
        if (result.panelDismissed) {
          onRequestClose?.();
          const fresh = makeSession();
          queueMicrotask(() => {
            setActiveId(fresh.id);
            if (projectId) {
              provisionedRef.current.add(fresh.id);
              void provisionSession(fresh.id);
            }
          });
          return [fresh];
        }
        if (result.nextActiveId) {
          const next = result.nextActiveId;
          queueMicrotask(() => setActiveId(next));
        }
        return result.sessions;
      });
    },
    [disposeSession, onRequestClose, projectId, provisionSession],
  );

  const closeAllSessions = useCallback(() => {
    sessionsRef.current.forEach((s) => disposeSession(s));
    onRequestClose?.();
    const fresh = makeSession();
    setSessions([fresh]);
    setActiveId(fresh.id);
    if (projectId) {
      provisionedRef.current.add(fresh.id);
      void provisionSession(fresh.id);
    }
  }, [disposeSession, onRequestClose, projectId, provisionSession]);

  // Honor parent "open a new terminal" requests (⌘⇧` in Workbench).
  const lastNonceRef = useRef<number | undefined>(newSessionNonce);
  useEffect(() => {
    if (newSessionNonce === undefined) return;
    if (lastNonceRef.current === newSessionNonce) return;
    lastNonceRef.current = newSessionNonce;
    addSession();
  }, [newSessionNonce, addSession]);

  // Tear everything down on unmount (panel close from outside, route
  // change, …). The server reaps idle sessions but DELETE'ing eagerly
  // saves a few seconds of resource hold-time.
  useEffect(() => {
    return () => {
      for (const s of sessionsRef.current) {
        try { s.client?.dispose() } catch {}
      }
    };
  }, []);

  // Re-fit the active xterm any time the panel becomes visible — the
  // FitAddon needs a layout pass to recompute cols/rows correctly when
  // the container was previously `display: none`.
  useEffect(() => {
    if (!visible) return;
    const handle = xtermRefs.current.get(activeId);
    handle?.refit();
    handle?.focus();
  }, [visible, activeId]);

  // ─── Toolbar actions ────────────────────────────────────────────────
  const stop = useCallback(() => {
    active?.client?.signal("INT");
  }, [active]);

  const clear = useCallback(() => {
    if (!active) return;
    xtermRefs.current.get(active.id)?.clear();
  }, [active]);

  /**
   * Run a preset by typing its command into the active shell. We hand it
   * to the PTY exactly as a user would: the shell echoes, history works,
   * Ctrl-C interrupts. Trailing `\r` is the carriage return bash treats
   * as Enter (LF doesn't trigger execution in line-disciplined PTY mode).
   */
  const runCommand = useCallback(
    (cmd: PresetCommandDto, confirmDangerous: boolean) => {
      if (!projectId) return;
      if (cmd.dangerous && !confirmDangerous) {
        setConfirming(cmd);
        return;
      }
      setConfirming(null);
      const client = active?.client;
      const text = cmd.command ?? cmd.id;
      if (!client) return;
      client.send(`${text}\r`);
      xtermRefs.current.get(active.id)?.focus();
    },
    [active, projectId],
  );

  // ─── Early exits ────────────────────────────────────────────────────
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-[#1e1e1e] p-6 text-center">
        <div className="max-w-md text-[12px] text-[#858585]">
          Open a project to use the terminal.
        </div>
      </div>
    );
  }

  if (Platform.OS !== "web") {
    return (
      <div className="flex h-full items-center justify-center bg-[#1e1e1e] p-6 text-center">
        <div className="max-w-md text-[12px] text-[#858585]">
          Terminal requires a desktop browser.
        </div>
      </div>
    );
  }

  const orderedCategories = [
    ...CATEGORY_ORDER.filter((k) => commands[k]?.length),
    ...Object.keys(commands).filter((k) => !CATEGORY_ORDER.includes(k)),
  ];

  const presetGroups = orderedCategories.map((cat) => ({
    category: cat,
    label: CATEGORY_LABEL[cat] ?? cat,
    commands: commands[cat] ?? [],
  }));

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <SessionTabs
        sessions={sessions}
        groupIds={groupIds}
        labels={labels}
        activeId={active?.id ?? ""}
        activeGroupId={activeGroupId}
        onSelectGroup={(groupId) => {
          const group = sessionsInGroup(sessionsRef.current, groupId);
          const target = group.find((s) => s.id === activeIdRef.current) ?? group[0];
          if (target) setActiveId(target.id);
        }}
        onCloseGroup={closeGroup}
        onCloseAll={closeAllSessions}
        onKillActive={() => closeSession(active?.id ?? "")}
        onAdd={addSession}
        onSplit={splitSession}
        onStop={stop}
        onClear={clear}
        clearDisabled={!active?.client}
        running={active?.status === "ready"}
        activeCwd={active?.cwd ?? null}
        presetGroups={presetGroups}
        presetsLoading={loading}
        presetsError={loadError}
        onRetryPresets={() => void loadCommands()}
        onRunPreset={(cmd) => runCommand(cmd, false)}
      />
      <div
        ref={panelRef}
        role="region"
        aria-label="Terminal output"
        className="relative min-h-0 flex-1 bg-[#1e1e1e]"
      >
        {/*
         * Render one container per *group* (tab). Only the active group is
         * shown (display:flex); the rest stay mounted but display:none so
         * background shells keep streaming and their scrollback survives a
         * tab switch. Within a group, every session renders side-by-side —
         * that's how a tab with >1 pane becomes a split. A single-pane group
         * is just a normal full-width terminal.
         */}
        {groupIds.map((gid) => {
          const groupSessions = sessionsInGroup(sessions, gid);
          const isActiveGroup = gid === activeGroupId;
          const isSplit = groupSessions.length > 1;
          return (
            <div
              key={gid}
              style={{
                position: "absolute",
                inset: 0,
                display: isActiveGroup ? "flex" : "none",
              }}
              className="h-full min-h-0 w-full bg-[#1e1e1e]"
            >
              <div className="flex min-w-0 flex-1">
                {groupSessions.map((s, index) => {
                  const isActive = s.id === active?.id;
                  return (
                    <div
                      key={s.id}
                      className="relative min-w-0 flex-1 border-r border-[#2d2d2d] last:border-r-0"
                      onMouseDown={() => setActiveId(s.id)}
                    >
                      {s.status === "error" ? (
                        <SessionErrorPane
                          message={s.errorMessage ?? "Failed to start terminal session"}
                          onRetry={() => {
                            patchSession(s.id, (cur) => ({ ...cur, status: "creating", errorMessage: null }));
                            void provisionSession(s.id);
                          }}
                        />
                      ) : !s.client ? (
                        <SessionStartingPane />
                      ) : (
                        <XtermView
                          ref={(handle) => {
                            if (handle) xtermRefs.current.set(s.id, handle);
                            else xtermRefs.current.delete(s.id);
                          }}
                          client={s.client}
                          hidden={!isActiveGroup}
                          autoFocus={isActive && isActiveGroup && visible}
                          projectId={projectId}
                          onCwdChange={(cwd) => {
                            patchSession(s.id, (cur) => ({ ...cur, cwd }));
                          }}
                        />
                      )}
                      {isSplit && index > 0 && (
                        <div className="pointer-events-none absolute left-0 top-0 h-full w-px bg-[#3c3c3c]" />
                      )}
                    </div>
                  );
                })}
              </div>
              {isSplit && (
                <TerminalSplitList
                  sessions={groupSessions}
                  labels={labels}
                  activeId={active?.id ?? ""}
                  onSelect={setActiveId}
                  onClose={closeSession}
                />
              )}
            </div>
          );
        })}
      </div>

      {confirming && (
        <ConfirmDangerous
          command={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => runCommand(confirming, true)}
        />
      )}
    </div>
  );
}

function TerminalSplitList({
  sessions,
  labels,
  activeId,
  onSelect,
  onClose,
}: {
  sessions: Session[];
  labels: Map<string, string>;
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <aside
      className="w-[148px] shrink-0 border-l border-[#2d2d2d] bg-[#1e1e1e] py-1 text-[12px] text-[#cccccc]"
      aria-label="Terminal splits"
    >
      {sessions.map((s, index) => {
        const active = s.id === activeId;
        return (
          <div
            key={s.id}
            className={[
              "group flex h-8 w-full items-center gap-1 px-2 text-left hover:bg-[#2a2d2e]",
              active ? "bg-[#37373d] text-[#ffffff]" : "text-[#cccccc]",
            ].join(" ")}
            aria-current={active ? "true" : undefined}
            title={labels.get(s.id) ?? `Terminal ${index + 1}`}
          >
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              className="flex min-w-0 flex-1 items-center gap-1 text-left"
            >
              <span className="w-4 shrink-0 text-[#858585]">{index === 0 ? "┌" : "└"}</span>
              <span className="shrink-0 rounded border border-[#858585] px-1 text-[10px] leading-4 text-[#cccccc]">⌁</span>
              <span className="min-w-0 flex-1 truncate">zsh</span>
              <span className="max-w-[54px] shrink-0 truncate text-[10px] text-[#858585]">{cwdBasename(s.cwd)}</span>
            </button>
            <button
              type="button"
              aria-label={`Kill ${labels.get(s.id) ?? `Terminal ${index + 1}`}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#858585] opacity-0 hover:bg-[#3c3c3c] hover:text-[#f48771] group-hover:opacity-100"
              title="Kill terminal"
            >
              ×
            </button>
          </div>
        );
      })}
    </aside>
  );
}

interface PresetGroup {
  category: string;
  label: string;
  commands: PresetCommandDto[];
}

function SessionTabs({
  sessions,
  groupIds,
  labels,
  activeId,
  activeGroupId,
  onSelectGroup,
  onCloseGroup,
  onCloseAll,
  onKillActive,
  onAdd,
  onSplit,
  onStop,
  onClear,
  clearDisabled,
  running,
  activeCwd,
  presetGroups,
  presetsLoading,
  presetsError,
  onRetryPresets,
  onRunPreset,
}: {
  sessions: Session[];
  groupIds: string[];
  labels: Map<string, string>;
  activeId: string;
  activeGroupId: string;
  onSelectGroup: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onCloseAll: () => void;
  onKillActive: () => void;
  onAdd: () => void;
  onSplit: () => void;
  onStop: () => void;
  onClear: () => void;
  clearDisabled: boolean;
  running: boolean;
  activeCwd: string | null;
  presetGroups: PresetGroup[];
  presetsLoading: boolean;
  presetsError: string | null;
  onRetryPresets: () => void;
  onRunPreset: (cmd: PresetCommandDto) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="relative flex shrink-0 items-center justify-between border-b border-[#2a2a2a] bg-[#1e1e1e] pr-2">
      <div role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 items-center overflow-x-auto">
        {groupIds.map((gid) => {
          const groupSessions = sessions.filter((s) => s.groupId === gid);
          // Representative pane for the tab's icon/cwd: the active session if
          // it lives in this group, else the group's first pane.
          const rep =
            groupSessions.find((s) => s.id === activeId) ?? groupSessions[0];
          if (!rep) return null;
          const active = gid === activeGroupId;
          const label = labels.get(rep.id) ?? rep.id;
          const paneCount = groupSessions.length;
          return (
            <div
              key={gid}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              aria-label={label}
              onClick={() => onSelectGroup(gid)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectGroup(gid);
                }
              }}
              className={`group flex shrink-0 cursor-pointer items-center gap-1 border-r border-[#2a2a2a] px-2 py-[6px] text-[11px] ${
                active
                  ? "bg-[#1e1e1e] text-white"
                  : "bg-[#252526] text-[#858585] hover:bg-[#2a2a2a] hover:text-white"
              }`}
            >
              {rep.status === "creating" ? (
                <Loader2 size={10} className="animate-spin text-[#0078d4]" />
              ) : rep.status === "error" ? (
                <AlertTriangle size={10} className="text-[#f48771]" />
              ) : rep.status === "closed" ? (
                <span className="inline-block h-2 w-2 rounded-full bg-[#858585]/60" />
              ) : (
                <span className="inline-block h-2 w-2 rounded-full bg-[#4ec9b0]/60" />
              )}
              <span className="flex max-w-[150px] flex-col leading-tight">
                <span className="truncate">
                  {label}
                  {paneCount > 1 ? ` (${paneCount})` : ""}
                </span>
                <span className="truncate text-[9px] text-[#858585]">{cwdBasename(rep.cwd)}</span>
              </span>
              <button
                type="button"
                title={`Close ${label}`}
                aria-label={`Close ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseGroup(gid);
                }}
                className={`ml-1 rounded p-[1px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white ${
                  active ? "opacity-100" : "opacity-60 group-hover:opacity-100"
                }`}
              >
                <X size={10} />
              </button>
            </div>
          );
        })}
        {/* Phase 3 chrome parity: the inline `+` (New Terminal) is gone from the
            tab strip. The new TerminalHeader on the right edge of this row owns
            "New Terminal" and "Launch Profile" affordances now, matching VS Code.
            The ▾ chevron below is kept because it opens the presets dropdown — a
            different feature that Phase 3 deliberately leaves alone. */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          title="Preset commands"
          aria-label="Preset commands"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="flex shrink-0 items-center gap-1 px-1 py-[6px] text-[#858585] hover:bg-[#2a2a2a] hover:text-white"
        >
          <ChevronDown size={12} />
        </button>
      </div>
      <div className="flex items-center gap-2 pr-1">
        <div
          className="flex max-w-[280px] items-center gap-1 truncate rounded px-2 py-1 font-mono text-[11px] text-[#cccccc]"
          title={displayCwd(activeCwd)}
          aria-label={`Current directory ${displayCwd(activeCwd)}`}
        >
          <span aria-hidden="true">📁</span>
          <span className="truncate">{displayCwd(activeCwd)}</span>
        </div>
        <PhasedTerminalHeader
          activeId={activeId}
          onNew={onAdd}
          onSplit={onSplit}
          onKillActive={onKillActive}
          running={running}
          onStop={onStop}
          onClear={onClear}
          clearDisabled={clearDisabled}
        />
      </div>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          {/*
           * Opens *upward* from the tab strip (Terminal lives at the
           * bottom of the IDE, more room above than below). `bottom-full`
           * anchors to the top edge of SessionTabs; `mb-1` gives a 4px
           * visual gap.
           */}
          <div
            className="absolute bottom-full left-0 z-50 mb-1 max-h-[min(60vh,420px)] w-60 overflow-auto rounded-md border border-[#2a2a2a] bg-[#252526] py-1 text-[12px] shadow-lg"
            role="menu"
          >
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                onAdd();
              }}
            >
              New Terminal
              <span className="ml-auto text-[10px] text-[#6a6a6a]">⌘⇧`</span>
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                onClear();
              }}
              disabled={clearDisabled}
            >
              Clear
            </MenuItem>
            <div className="my-1 h-px bg-[#2a2a2a]" />
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                onCloseGroup(activeGroupId);
              }}
            >
              Close Terminal
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                onCloseAll();
              }}
            >
              Close All Terminals
            </MenuItem>

            <div className="my-1 h-px bg-[#2a2a2a]" />
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#6a6a6a]">
              Run Preset
            </div>
            {presetsLoading ? (
              <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-[#858585]">
                <Loader2 size={11} className="animate-spin" /> Loading…
              </div>
            ) : presetsError ? (
              <div className="px-3 py-1 text-[11px] text-[#f48771]">
                <div className="mb-1 flex items-center gap-1">
                  <AlertTriangle size={11} /> {presetsError}
                </div>
                <button
                  onClick={() => {
                    onRetryPresets();
                  }}
                  className="mt-1 rounded bg-[#0078d4] px-2 py-[2px] text-[11px] text-white hover:bg-[#1184de]"
                >
                  Retry
                </button>
              </div>
            ) : presetGroups.length === 0 ? (
              <div className="px-3 py-1 text-[11px] text-[#858585]">No presets available.</div>
            ) : (
              presetGroups.map((group) => (
                <div key={group.category}>
                  <div className="px-3 pb-[2px] pt-2 text-[10px] uppercase tracking-wider text-[#6a6a6a]">
                    {group.label}
                  </div>
                  {group.commands.map((cmd) => (
                    <MenuItem
                      key={cmd.id}
                      onClick={() => {
                        setMenuOpen(false);
                        onRunPreset(cmd);
                      }}
                      title={cmd.description}
                    >
                      <span className="truncate">{cmd.label}</span>
                      {cmd.dangerous && (
                        <AlertTriangle size={11} className="ml-auto shrink-0 text-[#dcdcaa]" />
                      )}
                    </MenuItem>
                  ))}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      role="menuitem"
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[#cccccc] hover:bg-[#2a2a2a] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function SessionStartingPane(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center bg-[#1e1e1e]">
      <div className="flex items-center gap-2 text-[12px] text-[#858585]">
        <Loader2 size={12} className="animate-spin" /> Starting shell…
      </div>
    </div>
  );
}

function SessionErrorPane({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center bg-[#1e1e1e] p-4">
      <div className="max-w-md text-center">
        <div className="mb-2 flex items-center justify-center gap-2 text-[#f48771]">
          <AlertTriangle size={14} />
          <span className="text-[13px] font-semibold">Couldn't start terminal</span>
        </div>
        <div className="mb-3 break-words font-mono text-[11px] text-[#858585]">
          {message}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="rounded bg-[#0078d4] px-3 py-1 text-[12px] text-white hover:bg-[#1184de]"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function ConfirmDangerous({
  command,
  onCancel,
  onConfirm,
}: {
  command: PresetCommandDto;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = "destructive-confirm-title"
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[360px] rounded-lg border border-[#2a2a2a] bg-[#252526] p-4 shadow-2xl"
      >
        <div className="mb-2 flex items-center gap-2 text-[#dcdcaa]">
          <AlertTriangle size={14} />
          <span id={titleId} className="text-[13px] font-semibold">This is a destructive command</span>
        </div>
        <div className="mb-1 text-[13px] text-[#cccccc]">{command.label}</div>
        <div className="mb-4 text-[12px] leading-relaxed text-[#858585]">
          {command.description}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1 text-[12px] text-[#cccccc] hover:bg-[#ffffff1a]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-[#c72e2e] px-3 py-1 text-[12px] text-white hover:bg-[#d94545]"
          >
            Run anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Phase 3 wrapper that lifts `useShellName` into the tab-strip's render context
 * and forwards the action callbacks to `TerminalHeader`. Kept inline (rather
 * than as a separate file) because it's purely glue — the real header lives in
 * `./terminal/TerminalHeader.tsx` and the shell-name source of truth in
 * `./terminal/useShellName.ts`.
 *
 * Why a wrapper at all: `useShellName` is a hook, so we can't call it from
 * the tab-strip's props builder. The wrapper component gives us a render
 * context that can hold hook state.
 */
function PhasedTerminalHeader(props: {
  activeId: string;
  onNew: () => void;
  onSplit: () => void;
  onKillActive: () => void;
  running: boolean;
  onStop: () => void;
  onClear: () => void;
  clearDisabled: boolean;
}) {
  const { shellName, setShellName } = useShellName(props.activeId);
  return (
    <TerminalHeader
      shellName={shellName}
      onPickProfile={setShellName}
      onNew={props.onNew}
      onSplit={props.onSplit}
      onKill={props.onKillActive}
      running={props.running}
      onStop={props.onStop}
      onClear={props.onClear}
      clearDisabled={props.clearDisabled}
      onFind={() => window.dispatchEvent(new CustomEvent('shogo:terminal:find'))}
      onRename={() => window.dispatchEvent(new CustomEvent('shogo:terminal:rename'))}
      onConfigure={() => window.dispatchEvent(new CustomEvent('shogo:terminal:configure'))}
      onRunRecent={() => window.dispatchEvent(new CustomEvent('shogo:terminal:run-recent'))}
    />
  );
}
