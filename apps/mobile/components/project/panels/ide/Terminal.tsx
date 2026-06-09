// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Platform } from "react-native";
import {
  Square,
  Trash2,
  AlertTriangle,
  Loader2,
  Plus,
  X,
  ChevronDown,
  Terminal as TerminalIcon,
  Circle,
  SquareSplitHorizontal,
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
  colorsFor,
  groupIdsOf,
  isValidTabColor,
  labelsFor,
  makeSession,
  makeAgentSession,
  patchSession as patchSessionInList,
  renameGroup as renameGroupInList,
  reorderGroups as reorderGroupsInList,
  sessionsInGroup,
  setTabColor as setTabColorInList,
  type Session,
} from "./terminal/session-reducer";
import {
  insertLeafAtEdge as insertSplitLeafAtEdge,
  leaf as splitLeafNode,
  leafIds as splitLeafIds,
  movePane as detachSplitPane,
  removeLeaf as removeSplitLeaf,
  resize as resizeSplit,
  splitLeaf as splitTreeAtLeaf,
  type SplitNode,
} from "./terminal/split-tree";
import { TerminalHeader } from "./terminal/TerminalHeader";
import { useShellName, type ShellName } from "./terminal/useShellName";
import {
  AUTO_REPLY_STORAGE_KEY,
  defaultRuleTemplates,
  emptyAutoReplyState,
  evaluateAutoReplies,
  renderReply,
  validateRule,
  type AutoReplyRule,
  type AutoReplyState,
} from "./terminal/auto-replies";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cwdBasename(cwd: string | null | undefined): string {
  const v = displayCwd(cwd);
  if (v === "~") return "~";
  const parts = v.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? v;
  // Workspace folders are named by UUID — never show that as subtitle.
  if (UUID_RE.test(last)) return "";
  return last;
}

function wsBaseFromApi(apiBase: string): string {
  if (apiBase.startsWith("https://")) return "wss://" + apiBase.slice("https://".length);
  if (apiBase.startsWith("http://")) return "ws://" + apiBase.slice("http://".length);
  // Fallback for protocol-less URLs (shouldn't happen in practice).
  return apiBase;
}

export interface TerminalToolbarControls {
  shellName: string;
  running: boolean;
  clearDisabled: boolean;
  onNew: () => void;
  onSplitRight: () => void;
  onKillActive: () => void;
  onStop: () => void;
  onClear: () => void;
  onFind: () => void;
  onPickProfile: (name: ShellName) => void;
  onConfigure: () => void;
  onRunRecent: () => void;
}

export function Terminal({
  projectId,
  visible,
  newSessionNonce,
  onRequestClose,
  onControlsChange,
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
  /**
   * Called whenever active terminal session info changes — BottomPanel
   * uses this to show the toolbar in the VS Code-style panel header row.
   */
  onControlsChange?: (controls: TerminalToolbarControls | null) => void;
}) {
  const [commands, setCommands] = useState<Record<string, PresetCommandDto[]>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>(() => [makeSession()]);
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id ?? "t0");
  const [confirming, setConfirming] = useState<PresetCommandDto | null>(null);
  const [terminalSettingsOpen, setTerminalSettingsOpen] = useState(false);
  // Per-group split layout (Phase 3 — vertical + mixed grid splits).
  // Lazily initialised: any group not in this map renders a flat horizontal
  // row built from its sessions, matching the pre-split-tree behaviour.
  // Explicit entries record vertical / mixed / custom-sized layouts.
  const [groupLayouts, setGroupLayouts] = useState<Map<string, SplitNode>>(
    () => new Map([[sessions[0].groupId, splitLeafNode(sessions[0].id)]]),
  );
  // Auto-reply rules (Round 2). Persisted in localStorage; defaults are
  // the curated template list, all disabled. Loaded lazily on mount.
  const [autoReplyRules, setAutoReplyRules] = useState<AutoReplyRule[]>(() => {
    if (typeof window === "undefined") return defaultRuleTemplates();
    try {
      const raw = window.localStorage.getItem(AUTO_REPLY_STORAGE_KEY);
      if (!raw) return defaultRuleTemplates();
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return defaultRuleTemplates();
      const filtered = parsed.filter(
        (r): r is AutoReplyRule => typeof r === "object" && r != null && validateRule(r as AutoReplyRule) === null,
      );
      return filtered.length > 0 ? filtered : defaultRuleTemplates();
    } catch {
      return defaultRuleTemplates();
    }
  });
  // Per-session evaluator state. Keyed by Session.id — sliding window,
  // cooldown timestamps, recent-fires log. Survives re-renders via ref.
  const autoReplyStateRef = useRef(new Map<string, AutoReplyState>());
  // Mirror rules into a ref so the data subscription always reads the
  // latest array without re-subscribing on every rules edit.
  const autoReplyRulesRef = useRef(autoReplyRules);
  autoReplyRulesRef.current = autoReplyRules;

  const persistAutoReplyRules = useCallback((next: AutoReplyRule[]) => {
    setAutoReplyRules(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(AUTO_REPLY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Quota / privacy mode — silently drop; rules still apply in-session.
      }
    }
  }, []);

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

  const renameGroup = useCallback((groupId: string, label: string | null) => {
    setSessions((prev) => renameGroupInList(prev, groupId, label));
  }, []);

  const setTabColor = useCallback((groupId: string, color: string | null) => {
    setSessions((prev) => setTabColorInList(prev, groupId, color));
  }, []);

  const reorderGroups = useCallback(
    (fromGroupId: string, toGroupId: string, edge: "before" | "after") => {
      setSessions((prev) => reorderGroupsInList(prev, fromGroupId, toGroupId, edge));
    },
    [],
  );

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
        const existing = sessionsRef.current.find((x) => x.id === sessionId);
        if (isDesktopRuntime() && existing?.ptySessionId) {
          client = await createPtyClient({ sessionId: existing.ptySessionId });
          data = {
            id: existing.ptySessionId,
            cwd: existing.cwd ?? process.env.HOME ?? "/",
            cols: initial.cols,
            rows: initial.rows,
            createdAt: Date.now(),
          };
        } else if (isDesktopRuntime()) {
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
        // Auto-reply tap. Each chunk from the PTY is decoded and run through
        // the rule engine; matched fires are written back to stdin. The
        // engine state per session lives in `autoReplyStateRef`. Rules are
        // read from the ref so settings edits take effect on the next
        // chunk without resubscribing.
        const decoder = new TextDecoder("utf-8", { fatal: false });
        client.onData((bytes) => {
          try {
            const rules = autoReplyRulesRef.current;
            if (!rules || rules.length === 0) return;
            const enabled = rules.filter((r) => r.enabled);
            if (enabled.length === 0) return;
            const chunk = decoder.decode(bytes, { stream: true });
            const prev = autoReplyStateRef.current.get(sessionId) ?? emptyAutoReplyState();
            const result = evaluateAutoReplies(enabled, prev, chunk, Date.now());
            autoReplyStateRef.current.set(sessionId, result.nextState);
            for (const fire of result.fires) {
              try {
                client.send(renderReply(fire.send));
              } catch {
                // PTY closed mid-fire — ignore; cooldown still recorded.
              }
            }
          } catch {
            // Auto-reply must never crash the data path. Swallow + skip.
          }
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
      autoReplyStateRef.current.delete(s.id);
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

  // Agent long-running commands spawn a background ∞ Shogo tab via the
  // desktop terminal-exec server; attach the UI when main notifies us.
  useEffect(() => {
    if (Platform.OS !== "web" || !isDesktopRuntime()) return;
    const bridge = (globalThis as { shogoDesktopTerminal?: {
      onAgentTerminalSpawned?: (cb: (p: {
        sessionId: string
        terminalLabel: string
        cwd: string | null
      }) => void) => () => void
    } }).shogoDesktopTerminal;
    if (!bridge?.onAgentTerminalSpawned) return;
    return bridge.onAgentTerminalSpawned((payload) => {
      if (sessionsRef.current.some((s) => s.ptySessionId === payload.sessionId)) return;
      const s = makeAgentSession({
        ptySessionId: payload.sessionId,
        label: payload.terminalLabel,
        cwd: payload.cwd,
      });
      setSessions((prev) => addSessionToList(prev, s));
      setGroupLayouts((prev) => {
        const next = new Map(prev);
        next.set(s.groupId, splitLeafNode(s.id));
        return next;
      });
      setActiveId(s.id);
      if (projectId) {
        provisionedRef.current.add(s.id);
        void provisionSession(s.id);
      }
    });
  }, [projectId, provisionSession]);

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
    setGroupLayouts((prev) => {
      const next = new Map(prev);
      next.set(s.groupId, splitLeafNode(s.id));
      return next;
    });
    setActiveId(s.id);
    if (projectId) {
      provisionedRef.current.add(s.id);
      void provisionSession(s.id);
    }
  }, [projectId, provisionSession]);

  // "Split Terminal": a new pane inside the active session's group. Phase 3
  // accepts an explicit direction ('row' = Split Right, 'column' = Split
  // Down). Default is 'row' so all existing call sites and shortcuts that
  // pass no argument keep their horizontal-split behaviour.
  const splitSession = useCallback(
    (direction: "row" | "column" = "row") => {
      const current =
        sessionsRef.current.find((x) => x.id === activeIdRef.current) ??
        sessionsRef.current[0];
      if (!current) return;
      const s = makeSession(current.groupId);
      setSessions((prev) => addSplitToList(prev, s));
      setGroupLayouts((prev) => {
        const next = new Map(prev);
        const layout = prev.get(current.groupId) ?? splitLeafNode(current.id);
        next.set(current.groupId, splitTreeAtLeaf(layout, current.id, s.id, direction));
        return next;
      });
      setActiveId(s.id);
      if (projectId) {
        provisionedRef.current.add(s.id);
        void provisionSession(s.id);
      }
    },
    [projectId, provisionSession],
  );

  const closeSession = useCallback(
    (id: string) => {
      let closedSession: Session | undefined;
      setSessions((prev) => {
        const sess = prev.find((x) => x.id === id);
        closedSession = sess;
        if (sess) disposeSession(sess);
        const result = closeSessionInList(prev, id, activeId);
        if (result.panelDismissed) {
          onRequestClose?.();
          // Reset to a single fresh tab so the next reopen starts clean.
          const fresh = makeSession();
          setGroupLayouts(new Map([[fresh.groupId, splitLeafNode(fresh.id)]]));
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
      // Update the tree layout for the closed session's group, if we have one.
      if (closedSession) {
        setGroupLayouts((prev) => {
          const layout = prev.get(closedSession!.groupId);
          if (!layout) return prev;
          const after = removeSplitLeaf(layout, id);
          if (after === layout) return prev;
          const next = new Map(prev);
          if (after === null) next.delete(closedSession!.groupId);
          else next.set(closedSession!.groupId, after);
          return next;
        });
      }
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
          setGroupLayouts(new Map([[fresh.groupId, splitLeafNode(fresh.id)]]));
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
      setGroupLayouts((prev) => {
        if (!prev.has(groupId)) return prev;
        const next = new Map(prev);
        next.delete(groupId);
        return next;
      });
    },
    [disposeSession, onRequestClose, projectId, provisionSession],
  );

  /**
   * Move a pane (by sessionId) onto another pane's edge — possibly inside
   * a different group. Phase 4 ties the split-tree's `movePane` and
   * `insertLeafAtEdge` together AND reassigns the moved Session's
   * `groupId` so subsequent splits and renames stay consistent.
   *
   *   - If the source pane is the only pane in its source group, the
   *     source group is dropped (panel-collapse semantics inherited from
   *     `closeGroup`).
   *   - If source group ID === target group ID, the pane just moves
   *     within the same tree (rearrange-in-place is supported).
   *   - The active session is left as the moved pane so the user can
   *     keep typing into it after the drop.
   */
  const movePaneToTarget = useCallback(
    (
      paneSessionId: string,
      targetSessionId: string,
      edge: "left" | "right" | "top" | "bottom" | "center",
    ) => {
      if (paneSessionId === targetSessionId) return;
      const paneSession = sessionsRef.current.find((s) => s.id === paneSessionId);
      const targetSession = sessionsRef.current.find((s) => s.id === targetSessionId);
      if (!paneSession || !targetSession) return;
      const fromGroupId = paneSession.groupId;
      const toGroupId = targetSession.groupId;

      setGroupLayouts((prev) => {
        const next = new Map(prev);
        const sourceLayout = next.get(fromGroupId);
        // Same-group rearrange: detach + reinsert in one tree.
        if (fromGroupId === toGroupId) {
          if (!sourceLayout) return prev;
          const { tree: detached, node } = detachSplitPane(sourceLayout, paneSessionId);
          if (!node) return prev;
          if (!detached) {
            next.set(toGroupId, node);
            return next;
          }
          // Target may have shifted by one path level after detach — re-find by id.
          try {
            const updated = insertSplitLeafAtEdge(detached, targetSessionId, node, edge);
            next.set(toGroupId, updated);
          } catch {
            // Target was the moved pane itself (cancelled). Restore.
            next.set(fromGroupId, sourceLayout);
          }
          return next;
        }
        // Cross-group move: detach from source, attach to target.
        if (sourceLayout) {
          const { tree: detached, node } = detachSplitPane(sourceLayout, paneSessionId);
          if (!node) return prev;
          if (detached === null) next.delete(fromGroupId);
          else next.set(fromGroupId, detached);
        }
        const targetLayout = next.get(toGroupId);
        if (!targetLayout) {
          // Defensive: target group has no layout — shouldn't happen if it
          // had a pane to begin with. Re-derive a single leaf for the
          // existing target session and try again.
          next.set(toGroupId, splitLeafNode(targetSessionId));
        }
        const live = next.get(toGroupId)!;
        try {
          next.set(
            toGroupId,
            insertSplitLeafAtEdge(live, targetSessionId, splitLeafNode(paneSessionId), edge),
          );
        } catch {
          // Failed — roll back the detach.
          if (sourceLayout) next.set(fromGroupId, sourceLayout);
          return next;
        }
        return next;
      });

      // Reassign the moved session's groupId in the sessions array. The
      // tab strip + label code keys off groupId, so this is required.
      if (fromGroupId !== toGroupId) {
        setSessions((prev) => {
          // Remove from old position, append after the last session of
          // the target group to keep group contiguity.
          const sourceIdx = prev.findIndex((s) => s.id === paneSessionId);
          if (sourceIdx === -1) return prev;
          const moved: Session = { ...prev[sourceIdx], groupId: toGroupId };
          const without = prev.slice(0, sourceIdx).concat(prev.slice(sourceIdx + 1));
          let lastTargetIdx = -1;
          for (let i = 0; i < without.length; i++) {
            if (without[i].groupId === toGroupId) lastTargetIdx = i;
          }
          const at = lastTargetIdx === -1 ? without.length : lastTargetIdx + 1;
          const next = without.slice();
          next.splice(at, 0, moved);
          return next;
        });
      }
      setActiveId(paneSessionId);
    },
    [],
  );

  // Resize a split node at a given path inside a group's layout. Called
  // by the SplitDivider drag handler.
  const resizeSplitInGroup = useCallback(
    (groupId: string, path: number[], sizes: number[]) => {
      setGroupLayouts((prev) => {
        const layout = prev.get(groupId);
        if (!layout) return prev;
        const updated = resizeSplit(layout, path, sizes);
        const next = new Map(prev);
        next.set(groupId, updated);
        return next;
      });
    },
    [],
  );

  /**
   * Resolve the layout to render for a group. If the group has an explicit
   * entry in `groupLayouts` (set after a Split Right / Split Down / drag),
   * use it. Otherwise fall back to a flat horizontal row of every session
   * in that group — exactly the pre-Phase-3 behaviour.
   */
  const resolveLayout = useCallback(
    (groupId: string): SplitNode => {
      const explicit = groupLayouts.get(groupId);
      if (explicit) return explicit;
      const inGroup = sessionsInGroup(sessions, groupId);
      if (inGroup.length === 0) return splitLeafNode(""); // never rendered
      if (inGroup.length === 1) return splitLeafNode(inGroup[0].id);
      let tree: SplitNode = splitLeafNode(inGroup[0].id);
      for (let i = 1; i < inGroup.length; i++) {
        tree = splitTreeAtLeaf(tree, inGroup[i - 1].id, inGroup[i].id, "row");
      }
      return tree;
    },
    [groupLayouts, sessions],
  );

  const closeAllSessions = useCallback(() => {
    sessionsRef.current.forEach((s) => disposeSession(s));
    onRequestClose?.();
    const fresh = makeSession();
    setSessions([fresh]);
    setGroupLayouts(new Map([[fresh.groupId, splitLeafNode(fresh.id)]]));
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

  const openFind = useCallback(() => {
    if (!active) return;
    xtermRefs.current.get(active.id)?.openFind?.();
  }, [active]);

  const openRecent = useCallback(() => {
    if (!active) return;
    xtermRefs.current.get(active.id)?.openRecent?.();
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

  const { shellName, setShellName } = useShellName(active?.id ?? "");
  const running = active?.status === "ready";

  useEffect(() => {
    if (!onControlsChange) return;
    onControlsChange({
      shellName,
      running,
      clearDisabled: !active?.client,
      onNew: addSession,
      onSplitRight: () => splitSession("row"),
      onKillActive: () => closeSession(active?.id ?? ""),
      onStop: stop,
      onClear: clear,
      onFind: openFind,
      onPickProfile: setShellName,
      onConfigure: () => setTerminalSettingsOpen(true),
      onRunRecent: openRecent,
    });
  }, [shellName, running, active?.id, active?.client, onControlsChange]);

  useEffect(() => {
    return () => { onControlsChange?.(null); };
  }, []);

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
        onRenameGroup={renameGroup}
        onReorderGroup={reorderGroups}
        onSetTabColor={setTabColor}
        autoReplyRules={autoReplyRules}
        onChangeAutoReplyRules={persistAutoReplyRules}
        onCloseAll={closeAllSessions}
        onKillActive={() => closeSession(active?.id ?? "")}
        onAdd={addSession}
        onSplit={() => splitSession("row")}
        onSplitDown={() => splitSession("column")}
        onStop={stop}
        onClear={clear}
        onFind={openFind}
        onRunRecent={openRecent}
        onConfigure={() => setTerminalSettingsOpen(true)}
        clearDisabled={!active?.client}
        running={active?.status === "ready"}
        presetGroups={presetGroups}
        presetsLoading={loading}
        presetsError={loadError}
        onRetryPresets={() => void loadCommands()}
        onRunPreset={(cmd) => runCommand(cmd, false)}
        hideTabStrip
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
          const layout = resolveLayout(gid);
          const isSplit = splitLeafIds(layout).length > 1;
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
                <SplitNodeView
                  node={layout}
                  path={[]}
                  sessions={groupSessions}
                  activeId={active?.id ?? ""}
                  isActiveGroup={isActiveGroup}
                  visible={visible}
                  projectId={projectId}
                  xtermRefs={xtermRefs}
                  onSelect={setActiveId}
                  onPatch={patchSession}
                  onProvision={(sid) => void provisionSession(sid)}
                  onResize={(path, sizes) => resizeSplitInGroup(gid, path, sizes)}
                  onMovePane={movePaneToTarget}
                />
              </div>
              <TerminalAllInstanceList
                groups={groupIds}
                sessions={sessions}
                labels={labels}
                activeId={active?.id ?? ""}
                activeGroupId={activeGroupId}
                onSelectGroup={(gid) => {
                  const g = sessionsInGroup(sessionsRef.current, gid);
                  const t = g.find((s) => s.id === activeIdRef.current) ?? g[0];
                  if (t) setActiveId(t.id);
                }}
                onSelectSession={setActiveId}
                onCloseSession={closeSession}
                onSplitSession={() => splitSession("row")}
              />
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
      {terminalSettingsOpen && (
        <TerminalSettingsModal
          onClose={() => setTerminalSettingsOpen(false)}
          onOpenAutoReplies={() => {
            setTerminalSettingsOpen(false);
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("shogo:terminal:auto-replies"));
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * VS Code-style terminal instance list — always visible on the right side.
 * Shows every terminal group and their splits (panes) in a tree structure.
 * Clicking any row focuses that group/pane. On hover shows split + kill buttons.
 */
function TerminalAllInstanceList({
  groups,
  sessions,
  labels,
  activeId,
  activeGroupId,
  onSelectGroup,
  onSelectSession,
  onCloseSession,
  onSplitSession,
}: {
  groups: string[];
  sessions: Session[];
  labels: Map<string, string>;
  activeId: string;
  activeGroupId: string;
  onSelectGroup: (groupId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onSplitSession: () => void;
}): React.ReactElement | null {
  if (groups.length === 0) return null;

  type InstanceRow =
    | { kind: "group"; groupId: string; label: string; isActive: boolean }
    | { kind: "split"; sessionId: string; groupId: string; label: string; isLast: boolean; isActive: boolean };

  const rows: InstanceRow[] = [];
  for (const gid of groups) {
    const groupSessions = sessions.filter((s) => s.groupId === gid);
    const isActiveGroup = gid === activeGroupId;

    if (groupSessions.length === 1) {
      const s = groupSessions[0]!;
      rows.push({
        kind: "group",
        groupId: gid,
        label: labels.get(s.id) ?? "zsh",
        isActive: isActiveGroup && s.id === activeId,
      });
    } else {
      groupSessions.forEach((s, idx) => {
        if (idx === 0) {
          rows.push({
            kind: "group",
            groupId: gid,
            label: labels.get(s.id) ?? "zsh",
            isActive: isActiveGroup && s.id === activeId,
          });
        } else {
          rows.push({
            kind: "split",
            sessionId: s.id,
            groupId: gid,
            label: labels.get(s.id) ?? "zsh",
            isLast: idx === groupSessions.length - 1,
            isActive: isActiveGroup && s.id === activeId,
          });
        }
      });
    }
  }

  return (
    <aside
      className="flex w-[160px] shrink-0 flex-col border-l border-[#2d2d2d] bg-[#1e1e1e]"
      aria-label="Terminal instances"
    >
      {rows.map((row, i) => {
        const isActive = row.isActive;
        const baseClass = [
          "group flex h-[22px] w-full cursor-pointer select-none items-center text-left text-[11px]",
          isActive
            ? "bg-[#37373d] text-[#cccccc]"
            : "text-[#858585] hover:bg-[#2a2d2e] hover:text-[#cccccc]",
        ].join(" ");

        if (row.kind === "group") {
          return (
            <div
              key={`g-${row.groupId}-${i}`}
              className={baseClass}
              onClick={() => onSelectGroup(row.groupId)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectGroup(row.groupId); }}}
              title={row.label}
            >
              <span className="flex min-w-0 flex-1 items-center gap-[5px] pl-2">
                <TerminalIcon size={12} className="shrink-0" />
                <span className="truncate">{row.label}</span>
              </span>
              {isActive && (
                <span className="flex shrink-0 items-center gap-[1px] pr-1 opacity-0 group-hover:opacity-100">
                  <button
                    type="button"
                    title="Split Terminal"
                    aria-label="Split Terminal"
                    onClick={(e) => { e.stopPropagation(); onSplitSession(); }}
                    className="flex items-center justify-center rounded p-[2px] hover:bg-[#3c3c3c]"
                  >
                    <SquareSplitHorizontal size={11} />
                  </button>
                  <button
                    type="button"
                    title="Kill Terminal"
                    aria-label="Kill Terminal"
                    onClick={(e) => {
                      e.stopPropagation();
                      const s = sessions.find((x) => x.groupId === row.groupId);
                      if (s) onCloseSession(s.id);
                    }}
                    className="flex items-center justify-center rounded p-[2px] text-[#858585] hover:bg-[#3c3c3c] hover:text-[#f48771]"
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              )}
            </div>
          );
        }

        return (
          <div
            key={`s-${row.sessionId}-${i}`}
            className={baseClass}
            onClick={() => onSelectSession(row.sessionId)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectSession(row.sessionId); }}}
            title={row.label}
          >
            <span className="flex min-w-0 flex-1 items-center gap-[5px] pl-3">
              <span className="shrink-0 text-[#555555]">{row.isLast ? "└" : "├"}</span>
              <TerminalIcon size={12} className="shrink-0" />
              <span className="truncate">{row.label}</span>
            </span>
            <span className="flex shrink-0 items-center gap-[1px] pr-1 opacity-0 group-hover:opacity-100">
              <button
                type="button"
                title="Kill Split"
                aria-label="Kill Split"
                onClick={(e) => { e.stopPropagation(); onCloseSession(row.sessionId); }}
                className="flex items-center justify-center rounded p-[2px] text-[#858585] hover:bg-[#3c3c3c] hover:text-[#f48771]"
              >
                <Trash2 size={11} />
              </button>
            </span>
          </div>
        );
      })}
    </aside>
  );
}

function SessionTabs({
  sessions,
  groupIds,
  labels,
  activeId,
  activeGroupId,
  onSelectGroup,
  onCloseGroup,
  onRenameGroup,
  onReorderGroup,
  onSetTabColor,
  autoReplyRules,
  onChangeAutoReplyRules,
  onCloseAll,
  onKillActive,
  onAdd,
  onSplit,
  onSplitDown,
  onStop,
  onClear,
  onFind,
  onRunRecent,
  onConfigure,
  clearDisabled,
  running,
  presetGroups,
  presetsLoading,
  presetsError,
  onRetryPresets,
  onRunPreset,
  hideTabStrip,
}: {
  sessions: Session[];
  groupIds: string[];
  labels: Map<string, string>;
  activeId: string;
  activeGroupId: string;
  onSelectGroup: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onRenameGroup: (groupId: string, label: string | null) => void;
  onReorderGroup: (fromGroupId: string, toGroupId: string, edge: "before" | "after") => void;
  onSetTabColor: (groupId: string, color: string | null) => void;
  autoReplyRules: AutoReplyRule[];
  onChangeAutoReplyRules: (next: AutoReplyRule[]) => void;
  onCloseAll: () => void;
  onKillActive: () => void;
  onAdd: () => void;
  onSplit: () => void;
  onSplitDown?: () => void;
  onStop: () => void;
  onClear: () => void;
  onFind: () => void;
  onRunRecent: () => void;
  onConfigure: () => void;
  clearDisabled: boolean;
  running: boolean;
  presetGroups: PresetGroup[];
  presetsLoading: boolean;
  presetsError: string | null;
  onRetryPresets: () => void;
  onRunPreset: (cmd: PresetCommandDto) => void;
  hideTabStrip?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoRepliesOpen, setAutoRepliesOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const openAutoReplies = () => setAutoRepliesOpen(true);
    window.addEventListener("shogo:terminal:auto-replies", openAutoReplies);
    return () => window.removeEventListener("shogo:terminal:auto-replies", openAutoReplies);
  }, []);

  // groupId currently being renamed via the inline input. null = no edit
  // in progress. Lives in the tab strip so a parent rerender (e.g.
  // PTY output landing while the input is focused) doesn't trash it.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const startRename = useCallback((groupId: string, currentLabel: string) => {
    setRenamingGroupId(groupId);
    setRenameDraft(currentLabel);
  }, []);
  const commitRename = useCallback(() => {
    if (renamingGroupId == null) return;
    onRenameGroup(renamingGroupId, renameDraft);
    setRenamingGroupId(null);
    setRenameDraft("");
  }, [renamingGroupId, renameDraft, onRenameGroup]);
  const cancelRename = useCallback(() => {
    setRenamingGroupId(null);
    setRenameDraft("");
  }, []);

  useEffect(() => {
    if (renamingGroupId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingGroupId]);

  // Drag-to-reorder bookkeeping. dragGroupId is the gid being dragged;
  // dropTarget is the live drop indicator (target gid + edge). Both are
  // cleared on drop / dragend / Esc.
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ gid: string; edge: "before" | "after" } | null>(null);

  // Tab-color picker popover. `pickerForGroupId` is the gid whose dot was
  // clicked; null = closed. Memoised group color map so each tab renders
  // its current accent without an O(n) scan.
  const [pickerForGroupId, setPickerForGroupId] = useState<string | null>(null);
  const groupColors = useMemo(() => colorsFor(sessions), [sessions]);

  // Esc cancels an in-flight drag. We attach to window since the drag
  // image may be outside the strip's hit area.
  useEffect(() => {
    if (!dragGroupId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDragGroupId(null);
        setDropTarget(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragGroupId]);

  if (hideTabStrip) return null;

  return (
    <div className="relative flex shrink-0 items-center justify-between border-b border-[#2d2d2d] bg-[#252526] pr-1">
      <div role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:thin]">
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
          const tabColor = groupColors.get(gid) ?? null;
          return (
            <div
              key={gid}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              aria-label={label}
              draggable={renamingGroupId !== gid}
              onDragStart={(e) => {
                if (renamingGroupId === gid) return;
                e.dataTransfer.effectAllowed = "move";
                try { e.dataTransfer.setData("text/x-shogo-tab-gid", gid); } catch {}
                setDragGroupId(gid);
              }}
              onDragOver={(e) => {
                if (!dragGroupId || dragGroupId === gid) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const edge: "before" | "after" = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
                if (!dropTarget || dropTarget.gid !== gid || dropTarget.edge !== edge) {
                  setDropTarget({ gid, edge });
                }
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the strip entirely, not a child element.
                const next = e.relatedTarget as Node | null;
                if (next && (e.currentTarget as HTMLDivElement).contains(next)) return;
                if (dropTarget?.gid === gid) setDropTarget(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragGroupId && dragGroupId !== gid && dropTarget) {
                  onReorderGroup(dragGroupId, dropTarget.gid, dropTarget.edge);
                }
                setDragGroupId(null);
                setDropTarget(null);
              }}
              onDragEnd={() => {
                setDragGroupId(null);
                setDropTarget(null);
              }}
              onClick={() => {
                if (renamingGroupId !== gid) onSelectGroup(gid);
              }}
              onDoubleClick={() => startRename(gid, label)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectGroup(gid);
                } else if (e.key === "F2") {
                  e.preventDefault();
                  startRename(gid, label);
                }
              }}
              style={tabColor
                ? { borderBottom: `2px solid ${tabColor}`, borderTop: active ? '1px solid transparent' : '1px solid transparent' }
                : active
                  ? { borderTop: '1px solid #1e90ff' }
                  : { borderTop: '1px solid transparent' }
              }
              className={`group relative flex h-[35px] shrink-0 cursor-pointer items-center gap-[5px] border-r border-[#2d2d2d] px-3 text-[12px] ${
                active
                  ? "bg-[#1e1e1e] text-[#cccccc]"
                  : "bg-[#252526] text-[#858585] hover:bg-[#2d2d2d] hover:text-[#cccccc]"
              } ${dragGroupId === gid ? "opacity-50" : ""}`}
            >
              {dropTarget?.gid === gid && (
                <span
                  aria-hidden="true"
                  data-testid={`drop-indicator-${gid}-${dropTarget.edge}`}
                  className={`pointer-events-none absolute top-0 h-full w-[2px] bg-[#0078d4] ${
                    dropTarget.edge === "before" ? "left-0" : "right-0"
                  }`}
                />
              )}
              {rep.status === "creating" ? (
                <Loader2 size={10} className="animate-spin text-[#0078d4]" />
              ) : rep.status === "error" ? (
                <AlertTriangle size={10} className="text-[#f48771]" />
              ) : rep.status === "closed" ? (
                <span className="inline-block h-[8px] w-[8px] shrink-0 rounded-full bg-[#858585]" />
              ) : (
                <span className="inline-block h-[8px] w-[8px] shrink-0 rounded-full bg-[#4ec9b0]" />
              )}
              <span className="flex max-w-[140px] items-center leading-none">
                {renamingGroupId === gid ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                      e.stopPropagation();
                    }}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Rename ${label}`}
                    placeholder="Terminal"
                    maxLength={64}
                    className="w-[120px] truncate rounded-sm border border-[#0078d4] bg-[#1e1e1e] px-1 text-[12px] text-white outline-none"
                  />
                ) : (
                  <span className="truncate text-[12px]" title="Double-click or F2 to rename">
                    {rep.isAgentTerminal ? "∞ " : ""}
                    {label}
                    {paneCount > 1 ? ` (${paneCount})` : ""}
                  </span>
                )}
              </span>
              {tabColor && (
                <button
                  type="button"
                  title={`Change color for ${label}`}
                  aria-label={`Change color for ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPickerForGroupId((prev) => (prev === gid ? null : gid));
                  }}
                  className="rounded p-[1px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
                >
                  <span
                    className="inline-block h-[7px] w-[7px] rounded-full"
                    style={{ backgroundColor: tabColor }}
                  />
                </button>
              )}
              {!tabColor && (
                <button
                  type="button"
                  title={`Change color for ${label}`}
                  aria-label={`Change color for ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPickerForGroupId((prev) => (prev === gid ? null : gid));
                  }}
                  className="rounded p-[1px] text-[#858585] opacity-0 hover:bg-[#ffffff1a] hover:text-white group-hover:opacity-60"
                >
                  <span className="inline-block h-[7px] w-[7px] rounded-full border border-[#858585]" />
                </button>
              )}
              {pickerForGroupId === gid && (
                <TabColorPicker
                  current={tabColor}
                  onPick={(color) => {
                    onSetTabColor(gid, color);
                    setPickerForGroupId(null);
                  }}
                  onClose={() => setPickerForGroupId(null)}
                />
              )}
              <button
                type="button"
                title={`Close ${label}`}
                aria-label={`Close ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseGroup(gid);
                }}
                className={`ml-[2px] rounded p-[2px] text-[#858585] hover:bg-[#ffffff1a] hover:text-[#cccccc] ${
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-80"
                }`}
              >
                <X size={11} />
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
          className="flex h-[35px] shrink-0 items-center gap-1 px-2 text-[#858585] hover:bg-[#2d2d2d] hover:text-[#cccccc]"
        >
          <ChevronDown size={11} />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-[2px] border-l border-[#2d2d2d] pl-1 pr-1">
        <PhasedTerminalHeader
          activeId={activeId}
          onNew={onAdd}
          onSplit={onSplit}
          onSplitDown={onSplitDown}
          onKillActive={onKillActive}
          running={running}
          onStop={onStop}
          onClear={onClear}
          onFind={onFind}
          onRunRecent={onRunRecent}
          onRename={() => {
            const activeSession = sessions.find((s) => s.groupId === activeGroupId && s.id === activeId) ?? sessions.find((s) => s.groupId === activeGroupId);
            if (activeSession) startRename(activeGroupId, labels.get(activeSession.id) ?? activeSession.id);
          }}
          onConfigure={onConfigure}
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
      {autoRepliesOpen && (
        <AutoRepliesModal
          rules={autoReplyRules}
          onChange={onChangeAutoReplyRules}
          onClose={() => setAutoRepliesOpen(false)}
        />
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

const TERMINAL_SETTINGS_KEY = "shogo.desktop.terminal.settings.v1";
const TERMINAL_SETTINGS_DEFAULTS = {
  gpuEnabled: true,
  shellIntegrationEnabled: true,
  fontLigatures: true,
  telemetryEnabled: false,
  restorePolicy: "silent",
};

function useTerminalSettings() {
  const [settings, setSettings] = useState(() => {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(TERMINAL_SETTINGS_KEY) : null;
      return raw ? { ...TERMINAL_SETTINGS_DEFAULTS, ...JSON.parse(raw) } : TERMINAL_SETTINGS_DEFAULTS;
    } catch {
      return TERMINAL_SETTINGS_DEFAULTS;
    }
  });
  const set = useCallback((patch: Partial<typeof TERMINAL_SETTINGS_DEFAULTS>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(TERMINAL_SETTINGS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  return { settings, set };
}

function TerminalSettingsModal({
  onClose,
  onOpenAutoReplies,
}: {
  onClose: () => void;
  onOpenAutoReplies: () => void;
}): React.ReactElement {
  const { settings, set } = useTerminalSettings();

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-[2147483646] flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-settings-title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] overflow-auto rounded-lg border border-[#3c3c3c] bg-[#252526] p-4 text-[#cccccc] shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 id="terminal-settings-title" className="text-[13px] font-semibold text-white">Terminal settings</h2>
            <p className="mt-1 text-[11px] text-[#858585]">Quick controls for the active terminal panel.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close terminal settings"
            className="rounded p-1 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 text-[12px]">
          <div className="rounded border border-[#3c3c3c] bg-[#1e1e1e]">
            <div className="border-b border-[#3c3c3c] px-3 py-2">
              <div className="font-medium text-white">Appearance</div>
            </div>
            <SettingsToggle
              label="Font ligatures"
              description="Render → => != as connected glyphs (requires Fira Code, JetBrains Mono, or Cascadia Code)"
              value={settings.fontLigatures}
              onChange={(v) => set({ fontLigatures: v })}
            />
            <SettingsToggle
              label="GPU renderer"
              description="Use WebGL for faster terminal rendering. Disable if you see visual glitches."
              value={settings.gpuEnabled}
              onChange={(v) => set({ gpuEnabled: v })}
            />
          </div>

          <div className="rounded border border-[#3c3c3c] bg-[#1e1e1e]">
            <div className="border-b border-[#3c3c3c] px-3 py-2">
              <div className="font-medium text-white">Shell</div>
            </div>
            <SettingsToggle
              label="Shell integration (OSC 633)"
              description="Enables command decorations, CWD tracking, and navigate-by-command (⌘↑/↓)."
              value={settings.shellIntegrationEnabled}
              onChange={(v) => set({ shellIntegrationEnabled: v })}
            />
          </div>

          <button
            type="button"
            onClick={onOpenAutoReplies}
            className="flex w-full items-center justify-between rounded border border-[#3c3c3c] bg-[#1e1e1e] px-3 py-2 text-left hover:bg-[#2a2a2a]"
          >
            <span>
              <span className="block font-medium text-white">Auto-replies</span>
              <span className="text-[11px] text-[#9d9d9d]">Configure y/n prompt rules and confirmations.</span>
            </span>
            <ChevronDown size={14} className="-rotate-90 text-[#858585]" />
          </button>

          <div className="rounded border border-[#3c3c3c] bg-[#1e1e1e] p-3 text-[11px] text-[#9d9d9d]">
            <span className="font-medium text-[#cccccc]">Find & recent commands</span>
            <span className="ml-1">— use the terminal ⋯ menu or ⌘F / Ctrl+Alt+R.</span>
          </div>
          <div className="rounded border border-[#3c3c3c] bg-[#1e1e1e] p-3 text-[11px] text-[#9d9d9d]">
            Changes to GPU renderer and shell integration take effect on the next terminal spawn.
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SettingsToggle({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): React.ReactElement {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 px-3 py-2 hover:bg-[#2a2a2a]">
      <div>
        <div className="text-[12px] text-[#cccccc]">{label}</div>
        <div className="mt-[2px] text-[10px] text-[#858585]">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={(e) => { e.preventDefault(); onChange(!value); }}
        className={`relative mt-[2px] inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${
          value ? "bg-[#0078d4]" : "bg-[#3c3c3c]"
        }`}
      >
        <span
          aria-hidden
          className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition-transform duration-150 ${
            value ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </button>
    </label>
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
  onSplitDown?: () => void;
  onKillActive: () => void;
  running: boolean;
  onStop: () => void;
  onClear: () => void;
  onFind: () => void;
  onRename: () => void;
  onConfigure: () => void;
  onRunRecent: () => void;
  clearDisabled: boolean;
}) {
  const { shellName, setShellName } = useShellName(props.activeId);
  return (
    <TerminalHeader
      shellName={shellName}
      onPickProfile={setShellName}
      onNew={props.onNew}
      onSplit={props.onSplit}
      onSplitDown={props.onSplitDown}
      onKill={props.onKillActive}
      running={props.running}
      onStop={props.onStop}
      onClear={props.onClear}
      clearDisabled={props.clearDisabled}
      onFind={props.onFind}
      onRename={props.onRename}
      onConfigure={props.onConfigure}
      onRunRecent={props.onRunRecent}
    />
  );
}

// ─── Phase 3: recursive split-tree renderer ──────────────────────────────
//
// `SplitNodeView` walks a `SplitNode` and renders either:
//   • a leaf  → exactly the pane JSX the flat row used to render, or
//   • a split → a flex container in row/column direction, mapping children
//     with a `SplitDivider` between siblings.
//
// Sizes are CSS percentages applied to flexBasis. Dividers grab the
// pointer, capture clientX/Y deltas, and call onResize with normalised
// percentages on every frame. Double-click on a divider resets to even.

interface SplitNodeViewProps {
  node: SplitNode;
  path: number[];
  sessions: Session[];
  activeId: string;
  isActiveGroup: boolean;
  visible: boolean;
  projectId: string;
  xtermRefs: React.MutableRefObject<Map<string, XtermViewHandle | null>>;
  onSelect: (sessionId: string) => void;
  onPatch: (id: string, patch: (s: Session) => Session) => void;
  onProvision: (sessionId: string) => void;
  onResize: (path: number[], sizes: number[]) => void;
  /**
   * Phase 4 — pane drag-between-groups. Fires when a leaf drag ends
   * over another leaf with a chosen directional edge (or 'center' for
   * placeholder swap, currently unused). null in props.onMovePane
   * disables the feature; we leave it always-on at the parent.
   */
  onMovePane: (
    paneSessionId: string,
    targetSessionId: string,
    edge: "left" | "right" | "top" | "bottom" | "center",
  ) => void;
}

function SplitNodeView(props: SplitNodeViewProps): React.ReactElement | null {
  const { node } = props;
  if (node.kind === "leaf") {
    return <SplitLeafView {...props} sessionId={node.sessionId} />;
  }
  // Split node: render children flexed, dividers between them.
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1"
      style={{ flexDirection: node.direction }}
      role="group"
      aria-label={node.direction === "row" ? "Horizontal split" : "Vertical split"}
    >
      {node.children.map((child, i) => (
        <React.Fragment key={`${i}-${nodeKey(child)}`}>
          <div
            className="relative flex min-h-0 min-w-0"
            style={{
              flex: `${node.sizes[i]} 0 0`,
              flexDirection: node.direction,
            }}
          >
            <SplitNodeView {...props} node={child} path={[...props.path, i]} />
          </div>
          {i < node.children.length - 1 && (
            <SplitDivider
              direction={node.direction}
              onDrag={(deltaPct) => {
                const next = node.sizes.slice();
                next[i] = Math.max(5, next[i] + deltaPct);
                next[i + 1] = Math.max(5, next[i + 1] - deltaPct);
                props.onResize(props.path, next);
              }}
              onReset={() => {
                const even = 100 / node.children.length;
                props.onResize(
                  props.path,
                  node.children.map(() => even),
                );
              }}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function nodeKey(n: SplitNode): string {
  return n.kind === "leaf" ? `l:${n.sessionId}` : `s:${n.direction}:${n.children.length}`;
}

function SplitDivider(props: {
  direction: "row" | "column";
  onDrag: (deltaPct: number) => void;
  onReset: () => void;
}): React.ReactElement {
  const isRow = props.direction === "row";
  const startRef = useRef<{ x: number; y: number; containerSize: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      const parent = (e.currentTarget as HTMLDivElement).parentElement;
      const rect = parent?.getBoundingClientRect();
      const containerSize = isRow ? rect?.width ?? 1 : rect?.height ?? 1;
      startRef.current = { x: e.clientX, y: e.clientY, containerSize };
    },
    [isRow],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!startRef.current) return;
      const deltaPx = isRow ? e.clientX - startRef.current.x : e.clientY - startRef.current.y;
      const deltaPct = (deltaPx / startRef.current.containerSize) * 100;
      if (Math.abs(deltaPct) < 0.1) return;
      props.onDrag(deltaPct);
      // Move the anchor so subsequent deltas are relative to the new size.
      startRef.current.x = e.clientX;
      startRef.current.y = e.clientY;
    },
    [isRow, props],
  );
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.currentTarget as HTMLDivElement).hasPointerCapture(e.pointerId)) {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    }
    startRef.current = null;
  }, []);
  return (
    <div
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      aria-label={isRow ? "Resize horizontal split" : "Resize vertical split"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={props.onReset}
      className={
        isRow
          ? "z-10 w-1 shrink-0 cursor-col-resize self-stretch bg-transparent hover:bg-[#0078d4]/50"
          : "z-10 h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-[#0078d4]/50"
      }
      data-testid={`split-divider-${props.direction}`}
    />
  );
}

// ─── Phase 4: per-pane drag source + directional drop target ──────────────
//
// Each leaf becomes:
//   - A drag *source*: holding a DnD payload `text/x-shogo-pane-id` with the
//     sessionId of the dragged pane. The browser's native drag image is used
//     (no custom ghost) — simple, fast, accessible.
//   - A drag *target*: on dragover we compute which 5-way edge the pointer is
//     closest to (left / right / top / bottom / center) using the leaf's
//     bounding rect, render an overlay highlighting that edge, and on drop
//     fire `onMovePane(paneId, targetId, edge)`.
//
// The "center" zone is small (inner 20% by area) and currently triggers a
// 'center' edge — Phase 4 keeps it as a regular split direction; replacing
// the target pane outright is reserved for a future placeholder/template
// drop (e.g. moving into an empty group slot).

function SplitLeafView(
  props: SplitNodeViewProps & { sessionId: string },
): React.ReactElement | null {
  const s = props.sessions.find((x) => x.id === props.sessionId);
  const [dropEdge, setDropEdge] = useState<"left" | "right" | "top" | "bottom" | "center" | null>(null);
  if (!s) return null;
  const isActive = s.id === props.activeId;
  return (
    <div
      className="relative h-full min-h-0 min-w-0 flex-1 bg-[#1e1e1e]"
      onMouseDown={() => props.onSelect(s.id)}
      data-testid={`pane-${s.id}`}
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/x-shogo-pane-id", s.id); } catch {}
      }}
      onDragOver={(e) => {
        const paneId = readPaneDragId(e);
        if (!paneId || paneId === s.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const edge = edgeAt(rect, e.clientX, e.clientY);
        setDropEdge((prev) => (prev === edge ? prev : edge));
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && (e.currentTarget as HTMLDivElement).contains(next)) return;
        setDropEdge(null);
      }}
      onDrop={(e) => {
        const paneId = readPaneDragId(e);
        e.preventDefault();
        if (paneId && paneId !== s.id && dropEdge) {
          props.onMovePane(paneId, s.id, dropEdge);
        }
        setDropEdge(null);
      }}
    >
      {s.status === "error" ? (
        <SessionErrorPane
          message={s.errorMessage ?? "Failed to start terminal session"}
          onRetry={() => {
            props.onPatch(s.id, (cur) => ({ ...cur, status: "creating", errorMessage: null }));
            props.onProvision(s.id);
          }}
        />
      ) : !s.client ? (
        <SessionStartingPane />
      ) : (
        <XtermView
          ref={(handle) => {
            if (handle) props.xtermRefs.current.set(s.id, handle);
            else props.xtermRefs.current.delete(s.id);
          }}
          client={s.client}
          hidden={!props.isActiveGroup}
          autoFocus={isActive && props.isActiveGroup && props.visible}
          projectId={props.projectId}
          ptySessionId={s.ptySessionId}
          onCwdChange={(cwd) => {
            props.onPatch(s.id, (cur) => ({ ...cur, cwd }));
          }}
        />
      )}
      {dropEdge && <PaneDropOverlay edge={dropEdge} />}
    </div>
  );
}

function readPaneDragId(e: React.DragEvent): string | null {
  try {
    const id = e.dataTransfer.getData("text/x-shogo-pane-id");
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Decide which 5-way edge the (x, y) pointer is closest to inside `rect`.
 * Center is an inner box covering the middle 40% width × 40% height.
 * Outside center, we pick the nearest side using normalised distance.
 */
function edgeAt(
  rect: DOMRect,
  x: number,
  y: number,
): "left" | "right" | "top" | "bottom" | "center" {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  if (rx >= 0.3 && rx <= 0.7 && ry >= 0.3 && ry <= 0.7) return "center";
  const dLeft = rx;
  const dRight = 1 - rx;
  const dTop = ry;
  const dBottom = 1 - ry;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft) return "left";
  if (min === dRight) return "right";
  if (min === dTop) return "top";
  return "bottom";
}

function PaneDropOverlay(props: {
  edge: "left" | "right" | "top" | "bottom" | "center";
}): React.ReactElement {
  const cls: Record<typeof props.edge, string> = {
    left: "left-0 top-0 h-full w-1/2",
    right: "right-0 top-0 h-full w-1/2",
    top: "left-0 top-0 h-1/2 w-full",
    bottom: "left-0 bottom-0 h-1/2 w-full",
    center: "left-1/4 top-1/4 h-1/2 w-1/2",
  };
  return (
    <div
      aria-hidden="true"
      data-testid={`pane-drop-overlay-${props.edge}`}
      className={`pointer-events-none absolute z-20 border-2 border-[#0078d4] bg-[#0078d4]/20 ${cls[props.edge]}`}
    />
  );
}

// ─── Tab color picker ────────────────────────────────────────────────────
//
// A small popover anchored to the tab strip. 8 VS-Code-style preset accents
// plus a "Default" (clear) action plus a freeform `#rrggbb` input. Picks
// fire `onPick(color)` immediately and close the popover. Clicking outside
// closes (mousedown listener on window). Esc also closes.
//
// The palette colors are tuned to match VS Code's default terminal tab
// colors so power users feel at home.

const TAB_COLOR_PALETTE: ReadonlyArray<{ name: string; value: string }> = [
  { name: "Red",    value: "#f48771" },
  { name: "Orange", value: "#d19a66" },
  { name: "Yellow", value: "#dcdcaa" },
  { name: "Green",  value: "#4ec9b0" },
  { name: "Cyan",   value: "#56b6c2" },
  { name: "Blue",   value: "#0078d4" },
  { name: "Purple", value: "#c586c0" },
  { name: "Pink",   value: "#e06c75" },
];

function TabColorPicker(props: {
  current: string | null;
  onPick: (color: string | null) => void;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hexDraft, setHexDraft] = useState(props.current ?? "");
  const [hexError, setHexError] = useState(false);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && !ref.current.contains(e.target)) {
        props.onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [props]);

  const submitHex = useCallback(() => {
    const trimmed = hexDraft.trim();
    if (trimmed === "") {
      props.onPick(null);
      return;
    }
    if (!isValidTabColor(trimmed)) {
      setHexError(true);
      return;
    }
    props.onPick(trimmed.toLowerCase());
  }, [hexDraft, props]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Tab color"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute left-0 top-full z-30 mt-1 flex w-[200px] flex-col gap-2 rounded-md border border-[#3c3c3c] bg-[#252526] p-2 text-[11px] text-white shadow-lg"
    >
      <div className="grid grid-cols-4 gap-1">
        {TAB_COLOR_PALETTE.map((c) => (
          <button
            key={c.value}
            type="button"
            title={c.name}
            aria-label={c.name}
            data-testid={`tab-color-${c.name.toLowerCase()}`}
            onClick={() => props.onPick(c.value)}
            className={`h-6 w-full rounded border ${
              props.current === c.value ? "border-white" : "border-[#3c3c3c]"
            }`}
            style={{ backgroundColor: c.value }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => props.onPick(null)}
        className={`rounded border px-2 py-1 text-left text-[10px] ${
          props.current === null ? "border-white" : "border-[#3c3c3c] hover:bg-[#2a2a2a]"
        }`}
      >
        Default (no color)
      </button>
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={hexDraft}
          onChange={(e) => {
            setHexDraft(e.target.value);
            setHexError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitHex();
            }
          }}
          placeholder="#rrggbb"
          maxLength={7}
          aria-invalid={hexError}
          aria-label="Custom hex color"
          className={`flex-1 rounded-sm border bg-[#1e1e1e] px-1 py-[2px] text-[10px] outline-none ${
            hexError ? "border-[#f48771]" : "border-[#3c3c3c]"
          }`}
        />
        <button
          type="button"
          onClick={submitHex}
          className="rounded border border-[#3c3c3c] px-2 py-[2px] text-[10px] hover:bg-[#2a2a2a]"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

// ─── Auto-replies settings modal ─────────────────────────────────────────
//
// A small fixed-position dialog hosted by SessionTabs that lets the user
// add / edit / toggle / delete `AutoReplyRule`s. Persists via the parent's
// `onChange` callback. Each row exposes:
//
//   - enable/disable toggle
//   - label (text)
//   - match kind (substring | regex)
//   - pattern
//   - response text
//   - "append newline" toggle
//
// Saving runs `validateRule` and surfaces the error inline if the user
// typed an invalid regex. Closing the modal flushes any pending edits to
// the parent — there's no per-row save button to reduce clicks.

function AutoRepliesModal(props: {
  rules: AutoReplyRule[];
  onChange: (next: AutoReplyRule[]) => void;
  onClose: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<AutoReplyRule[]>(props.rules);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateAndSet = useCallback((next: AutoReplyRule[]) => {
    const nextErrors: Record<string, string> = {};
    for (const r of next) {
      const err = validateRule(r);
      if (err) nextErrors[r.id] = err;
    }
    setDraft(next);
    setErrors(nextErrors);
  }, []);

  const updateRule = useCallback(
    (id: string, patch: Partial<AutoReplyRule>) => {
      validateAndSet(draft.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [draft, validateAndSet],
  );

  const addRule = useCallback(() => {
    const newRule: AutoReplyRule = {
      id: `rule-${Date.now().toString(36)}`,
      label: "New rule",
      enabled: false,
      match: { kind: "substring", pattern: "" },
      send: { text: "", appendNewline: true },
    };
    validateAndSet([...draft, newRule]);
  }, [draft, validateAndSet]);

  const deleteRule = useCallback(
    (id: string) => {
      validateAndSet(draft.filter((r) => r.id !== id));
    },
    [draft, validateAndSet],
  );

  const commit = useCallback(() => {
    // Drop rules with current errors before persisting; the user can still
    // see + fix them by reopening the modal.
    const clean = draft.filter((r) => !errors[r.id]);
    props.onChange(clean);
    props.onClose();
  }, [draft, errors, props]);

  return createPortal(
    <div
      role="dialog"
      aria-label="Auto-replies"
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/60 p-4"
      onClick={props.onClose}
    >
      <div
        className="flex max-h-[calc(100vh-32px)] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden rounded-md border border-[#3c3c3c] bg-[#252526] text-[12px] text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#3c3c3c] px-3 py-2">
          <div className="font-semibold">Terminal auto-replies</div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            className="rounded p-1 text-[#858585] hover:bg-[#2a2a2a] hover:text-white"
          >
            <X size={12} />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-3 py-2">
          {draft.length === 0 ? (
            <div className="py-6 text-center text-[#858585]">
              No rules configured. Click "Add rule" below.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {draft.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-2 rounded border border-[#3c3c3c] bg-[#1e1e1e] p-2"
                  data-testid={`auto-reply-rule-${r.id}`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => updateRule(r.id, { enabled: e.target.checked })}
                      aria-label={`Enable ${r.label}`}
                    />
                    <input
                      type="text"
                      value={r.label}
                      onChange={(e) => updateRule(r.id, { label: e.target.value })}
                      placeholder="Rule name"
                      className="flex-1 rounded-sm border border-[#3c3c3c] bg-[#252526] px-1 py-[2px] text-[11px] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => deleteRule(r.id)}
                      aria-label={`Delete ${r.label}`}
                      className="rounded p-1 text-[#858585] hover:bg-[#2a2a2a] hover:text-[#f48771]"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-[#858585]">When stdout matches</label>
                    <select
                      value={r.match.kind}
                      onChange={(e) =>
                        updateRule(r.id, {
                          match: { ...r.match, kind: e.target.value as "substring" | "regex" },
                        })
                      }
                      className="rounded-sm border border-[#3c3c3c] bg-[#252526] px-1 py-[2px] text-[10px] outline-none"
                    >
                      <option value="substring">substring</option>
                      <option value="regex">regex</option>
                    </select>
                    <input
                      type="text"
                      value={r.match.pattern}
                      onChange={(e) =>
                        updateRule(r.id, { match: { ...r.match, pattern: e.target.value } })
                      }
                      placeholder={r.match.kind === "regex" ? "/pattern/" : "y/N"}
                      className="flex-1 rounded-sm border border-[#3c3c3c] bg-[#252526] px-1 py-[2px] font-mono text-[11px] outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-[#858585]">Send</label>
                    <input
                      type="text"
                      value={r.send.text}
                      onChange={(e) =>
                        updateRule(r.id, { send: { ...r.send, text: e.target.value } })
                      }
                      placeholder="y"
                      className="flex-1 rounded-sm border border-[#3c3c3c] bg-[#252526] px-1 py-[2px] font-mono text-[11px] outline-none"
                    />
                    <label className="flex items-center gap-1 text-[10px]">
                      <input
                        type="checkbox"
                        checked={r.send.appendNewline}
                        onChange={(e) =>
                          updateRule(r.id, {
                            send: { ...r.send, appendNewline: e.target.checked },
                          })
                        }
                      />
                      Enter
                    </label>
                  </div>
                  {errors[r.id] && (
                    <div className="rounded bg-[#3c1a1a] px-2 py-1 text-[10px] text-[#f48771]">
                      {errors[r.id]}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[#3c3c3c] px-3 py-2">
          <button
            type="button"
            onClick={addRule}
            className="rounded border border-[#3c3c3c] px-2 py-1 text-[11px] hover:bg-[#2a2a2a]"
          >
            + Add rule
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={props.onClose}
              className="rounded border border-[#3c3c3c] px-3 py-1 text-[11px] hover:bg-[#2a2a2a]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={Object.keys(errors).length > 0}
              className="rounded bg-[#0078d4] px-3 py-1 text-[11px] hover:bg-[#0066b3] disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
