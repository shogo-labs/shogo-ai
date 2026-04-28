// SPDX-License-Identifier: AGPL-3.0-or-later
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

/**
 * The IDE "Terminal" — a dual-mode runner for project workspaces.
 *
 * Two ways to execute:
 *   1. Preset commands in the left rail (install, generate, typecheck, …).
 *      Backed by POST /api/projects/:projectId/terminal/exec.
 *   2. A free-form `$` prompt at the bottom of each session. Type any shell
 *      command and it runs inside the project's sandboxed workspace dir.
 *      Backed by POST /api/projects/:projectId/terminal/run.
 *
 * Multi-session (VS Code parity):
 *   - Each tab owns its own output buffer, prompt history, and in-flight
 *     command. Labels are derived from the tab's *position* so closing a
 *     middle tab doesn't leave gaps like "Terminal 3, Terminal 5".
 *   - Closing the *last* tab dismisses the bottom panel entirely (matches
 *     the user's mental model: "X on the last terminal should hide the
 *     whole thing, not spawn a new one").
 *
 * Synthetic persistent shell:
 *   - `bash -c` is spawned fresh for every command, so shell-local state
 *     (`cd`, `export`, aliases) doesn't naturally survive. We give users the
 *     illusion of a long-lived shell by tracking `cwd` + `prevCwd` per
 *     session and passing them with every run. The server `cd`s into `cwd`
 *     before the command and reports the post-command `pwd` back on an
 *     out-of-band stream channel (wrapped in 0x1E record-separator bytes so
 *     it can't collide with program output). The client parses it, updates
 *     state, and the next command starts from the new directory. Enough to
 *     make `cd`, `cd -`, `cd ..`, `pwd`, pipes, redirects, subshells, etc.
 *     all feel like a real terminal.
 *
 * Why no raw PTY / xterm.js: the product is agent-first (commit 7f9bdd0), so
 * we lean on simple streamed stdout over HTTP instead of a persistent shell.
 * That covers ~all real workflows (`ls`, `cat`, `bun run …`, `git status`,
 * `curl`, …) without the maintenance surface of a terminal emulator.
 */

interface PresetCommandDto {
  id: string;
  label: string;
  description: string;
  category: string;
  dangerous: boolean;
}

interface Session {
  id: string;
  output: string;
  /** Non-null while a command (preset or free-form) is streaming. */
  runningCmdId: string | null;
  abort: AbortController | null;
  /** Free-form prompt history, oldest → newest. */
  history: string[];
  /**
   * Synthetic-shell cwd for this tab. `null` means "server default"
   * (project workspace root) — we resolve it lazily on first command so
   * new tabs don't need an up-front API call. Updated from the
   * out-of-band metadata trailer after every command.
   */
  cwd: string | null;
  /** Previous cwd so `cd -` works across independent `bash -c` invocations. */
  prevCwd: string | null;
}

/**
 * Record-Separator framed trailer emitted by the server after a free-form
 * command finishes. Carries `{ cwd, exitCode, signal }` as base64-encoded
 * JSON. Kept in sync with META_SENTINEL_{PREFIX,SUFFIX} in
 * apps/api/src/routes/terminal.ts — change both or neither.
 */
const META_SENTINEL_RE = /\u001eSHOGO_TERM_META:([A-Za-z0-9+/=]+)\u001e\n?/;

interface RunMeta {
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
}

/**
 * Strip any complete metadata sentinel out of `buf`, returning the decoded
 * payload (if any) plus the remaining buffer with the sentinel removed.
 * Callers feed chunks in progressively and hold back a tail to handle
 * sentinels that straddle chunk boundaries.
 */
function extractMeta(buf: string): { meta: RunMeta | null; rest: string } {
  const m = META_SENTINEL_RE.exec(buf);
  if (!m) return { meta: null, rest: buf };
  let meta: RunMeta | null = null;
  try {
    const json =
      typeof atob === "function"
        ? atob(m[1])
        : Buffer.from(m[1], "base64").toString("utf8");
    meta = JSON.parse(json) as RunMeta;
  } catch {
    meta = null;
  }
  return { meta, rest: buf.slice(0, m.index) + buf.slice(m.index + m[0].length) };
}

const CATEGORY_LABEL: Record<string, string> = {
  package: "Package",
  database: "Database",
  server: "Server",
  test: "Test",
  build: "Build",
};

const CATEGORY_ORDER: string[] = ["package", "database", "test", "build", "server"];

let sessionIdSeq = 0;
const makeSession = (): Session => ({
  id: `t-${Date.now().toString(36)}-${++sessionIdSeq}`,
  output: "",
  runningCmdId: null,
  abort: null,
  history: [],
  cwd: null,
  prevCwd: null,
});

/**
 * Best-effort "looks like an absolute POSIX path inside this project".
 * Purely cosmetic — used to decide whether to render the prompt as `~/foo`
 * (inside project) or `/abs/path` (user cd'd elsewhere). Not a security
 * boundary; the server enforces/ignores escape as it sees fit.
 */
function formatPromptCwd(cwd: string | null): string {
  if (!cwd) return "";
  // Show last two path segments for compactness, but keep absolute form if we
  // only have one (`/tmp` stays `/tmp`).
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  if (parts.length === 1) return "/" + parts[0];
  return parts.slice(-2).join("/");
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>(() => [makeSession()]);
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id ?? "t0");
  const [confirming, setConfirming] = useState<PresetCommandDto | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const apiBase = API_URL;
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  // Labels are positional — derived on every render so closing tab #2 leaves
  // "Terminal 1, Terminal 2" instead of "Terminal 1, Terminal 3".
  const labels = useMemo(
    () => new Map(sessions.map((s, i) => [s.id, `Terminal ${i + 1}`])),
    [sessions],
  );

  // ─── Preset commands ────────────────────────────────────────────────
  const loadCommands = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await agentFetch(`${apiBase}/api/projects/${projectId}/terminal/commands`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        throw new Error(body.error?.message ?? `${res.status}`);
      }
      const json = (await res.json()) as { commands: Record<string, PresetCommandDto[]> };
      setCommands(json.commands ?? {});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiBase, projectId]);

  // Load presets when the panel becomes visible for a project. We bail on
  // *any* prior attempt — success, in-flight, or error — so we don't tight-
  // loop the API. The error case is the load-bearing one: in staging the
  // proxy legitimately returns 503 ("service_starting") while the runtime
  // pod cold-starts, and without this guard the effect re-fires on every
  // setLoading(false) → setLoadError() pair, hammering the endpoint until
  // the pod comes up. Users recover via the "Retry" button in the menu
  // (wired to loadCommands directly).
  const loadAttemptedRef = useRef(false);
  useEffect(() => {
    if (!visible) return;
    if (!projectId) return;
    if (loadAttemptedRef.current) return;
    if (loading) return;
    loadAttemptedRef.current = true;
    void loadCommands();
  }, [visible, projectId, loading, loadCommands]);

  // Reset the attempt flag whenever the project changes so we re-fetch
  // for the new project (and only once).
  useEffect(() => {
    loadAttemptedRef.current = false;
  }, [projectId]);

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.output]);

  // Auto-focus the prompt when the terminal first becomes visible, when the
  // user switches sessions, or when a command finishes running. Mirrors
  // Cursor/VS Code: clicking the Terminal tab should always leave the cursor
  // ready to type.
  useEffect(() => {
    if (!visible) return;
    if (active?.runningCmdId) return;
    // RAF so we focus after the input has actually been painted.
    const raf = requestAnimationFrame(() => promptInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [visible, activeId, active?.runningCmdId]);

  // ─── Session management ─────────────────────────────────────────────
  const addSession = useCallback(() => {
    const s = makeSession();
    setSessions((prev) => [...prev, s]);
    setActiveId(s.id);
  }, []);

  const closeSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const sess = prev.find((x) => x.id === id);
        sess?.abort?.abort();
        const next = prev.filter((x) => x.id !== id);
        // Closing the last terminal should dismiss the whole bottom panel —
        // VS Code does this and it matches the "X = close this thing" intent.
        if (next.length === 0) {
          onRequestClose?.();
          // Keep a placeholder so that if the panel gets reopened without
          // unmounting us (shouldn't happen today, but belt-and-suspenders),
          // we have a session to show.
          const fresh = makeSession();
          queueMicrotask(() => setActiveId(fresh.id));
          return [fresh];
        }
        if (id === activeId) {
          const idx = prev.findIndex((x) => x.id === id);
          const neighbour = next[Math.max(0, Math.min(idx, next.length - 1))];
          queueMicrotask(() => setActiveId(neighbour.id));
        }
        return next;
      });
    },
    [activeId, onRequestClose],
  );

  const closeAllSessions = useCallback(() => {
    sessionsRef.current.forEach((s) => s.abort?.abort());
    onRequestClose?.();
    // Reset to a single empty session so next open is clean.
    const fresh = makeSession();
    setSessions([fresh]);
    setActiveId(fresh.id);
  }, [onRequestClose]);

  // Honor parent "open a new terminal" requests (⌘⇧` in Workbench)
  const lastNonceRef = useRef<number | undefined>(newSessionNonce);
  useEffect(() => {
    if (newSessionNonce === undefined) return;
    if (lastNonceRef.current === newSessionNonce) return;
    lastNonceRef.current = newSessionNonce;
    addSession();
  }, [newSessionNonce, addSession]);

  const patchSession = useCallback((id: string, patch: (s: Session) => Session) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? patch(s) : s)));
  }, []);

  // ─── Output batching ────────────────────────────────────────────────
  // Chunks from `fetch().body.getReader()` arrive as often as the TCP
  // stack delivers them — for verbose commands (`yes`, `find /`,
  // `bun install`) that's thousands of tiny writes per second. Rendering
  // a fresh React tree for each chunk pegs the main thread. Instead we
  // accumulate per-session text in a ref and flush once per animation
  // frame, so React only runs reconciliation ~60×/sec regardless of how
  // chatty the command is.
  const pendingOutputRef = useRef<Map<string, string>>(new Map());
  const flushScheduledRef = useRef(false);
  const flushPending = useCallback(() => {
    flushScheduledRef.current = false;
    const pending = pendingOutputRef.current;
    if (pending.size === 0) return;
    const snapshot = new Map(pending);
    pending.clear();
    setSessions((prev) =>
      prev.map((s) => {
        const extra = snapshot.get(s.id);
        return extra ? { ...s, output: s.output + extra } : s;
      }),
    );
  }, []);
  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flushPending);
    } else {
      // Tests / non-browser environments: fall back to microtask.
      queueMicrotask(flushPending);
    }
  }, [flushPending]);
  const appendOutput = useCallback(
    (id: string, text: string) => {
      if (!text) return;
      const map = pendingOutputRef.current;
      map.set(id, (map.get(id) ?? "") + text);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  // Drain any pending rAF-buffered output on unmount so we don't leak
  // state into a next mount that happens to reuse a session id.
  useEffect(() => {
    return () => {
      pendingOutputRef.current.clear();
    };
  }, []);

  // ─── Shared streaming helper ────────────────────────────────────────
  /**
   * Stream a text-chunked HTTP response into a session's output buffer.
   * Handles AbortError cleanly and always clears the running flag.
   */
  const streamInto = useCallback(
    async (targetId: string, tag: string, res: Response, ctl: AbortController) => {
      try {
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { code?: string; message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) appendOutput(targetId, chunk);
        }
      } catch (err) {
        // Flush any batched output first so the trailer always lands
        // *after* the actual command output, not a frame earlier.
        flushPending();
        if ((err as { name?: string })?.name === "AbortError") {
          patchSession(targetId, (s) => ({ ...s, output: s.output + "\n[Cancelled]\n" }));
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          patchSession(targetId, (s) => ({ ...s, output: s.output + `\n[Error ${tag}] ${msg}\n` }));
        }
      } finally {
        flushPending();
        patchSession(targetId, (s) =>
          s.abort === ctl ? { ...s, runningCmdId: null, abort: null } : s,
        );
      }
    },
    [appendOutput, flushPending, patchSession],
  );

  // ─── Run preset ─────────────────────────────────────────────────────
  const runCommand = useCallback(
    async (cmd: PresetCommandDto, confirmDangerous: boolean) => {
      if (!projectId) return;
      const targetId = activeId;
      const target = sessionsRef.current.find((s) => s.id === targetId);
      if (!target) return;
      if (target.runningCmdId) return;
      if (cmd.dangerous && !confirmDangerous) {
        setConfirming(cmd);
        return;
      }
      setConfirming(null);
      const ctl = new AbortController();
      // Flush any rAF-batched chunks so the preset header lands after
      // whatever output the previous command was still emitting.
      flushPending();
      patchSession(targetId, (s) => ({
        ...s,
        runningCmdId: cmd.id,
        abort: ctl,
        output: (s.output ? s.output + "\n" : "") + `──── ${cmd.label} ────\n`,
      }));
      const res = await agentFetch(`${apiBase}/api/projects/${projectId}/terminal/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: cmd.id, confirmDangerous }),
        signal: ctl.signal,
      }).catch((err) => {
        // Normalise network-layer abort into a synthetic response so the
        // shared streaming path can log it consistently.
        throw err;
      });
      await streamInto(targetId, cmd.label, res, ctl);
    },
    [apiBase, projectId, activeId, patchSession, streamInto, flushPending],
  );

  // ─── Run free-form command from the prompt ──────────────────────────
  const runFreeCommand = useCallback(
    async (command: string) => {
      const trimmed = command.trim();
      if (!trimmed || !projectId) return;
      const targetId = activeId;
      const target = sessionsRef.current.find((s) => s.id === targetId);
      if (!target) return;
      if (target.runningCmdId) return;

      // Record the command in history *before* handling built-ins so that ↑
      // recalls `clear` / `exit` the same as any other line.
      const pushHistory = (s: Session): Session => ({
        ...s,
        history:
          s.history[s.history.length - 1] === trimmed
            ? s.history
            : [...s.history, trimmed].slice(-100),
      });

      // Built-ins handled client-side — these have no meaningful output or
      // would require a real PTY to behave correctly (`clear` emits raw ANSI
      // escapes that our <pre> can't interpret). Mirrors VS Code's behavior
      // where ⌘K also clears the buffer without a server round-trip.
      if (trimmed === "clear" || trimmed === "cls") {
        // Drop any rAF-batched chunks for this session so they don't bleed
        // back in on the next animation frame.
        pendingOutputRef.current.delete(targetId);
        patchSession(targetId, (s) => pushHistory({ ...s, output: "" }));
        return;
      }
      if (trimmed === "exit" || trimmed === "logout") {
        flushPending();
        patchSession(targetId, (s) =>
          pushHistory({ ...s, output: s.output + "\n[session closed]\n" }),
        );
        return;
      }

      const ctl = new AbortController();
      // Render the prompt line that the user just submitted, the way a real
      // shell echoes what you typed before showing output. Using the tab's
      // current cwd (best-effort formatted) makes `cd somewhere` + next
      // command obviously originate from the new directory.
      const echoPrefix = `${formatPromptCwd(target.cwd) || "~"} $ `;
      // Make sure any output still sitting in the rAF batch is committed
      // so the echoed prompt doesn't appear before the previous command's
      // last lines.
      flushPending();
      patchSession(targetId, (s) =>
        pushHistory({
          ...s,
          runningCmdId: `free:${trimmed}`,
          abort: ctl,
          output:
            (s.output ? s.output.replace(/\n?$/, "\n") : "") +
            `${echoPrefix}${trimmed}\n`,
        }),
      );

      try {
        const res = await agentFetch(`${apiBase}/api/projects/${projectId}/terminal/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: trimmed,
            cwd: target.cwd ?? undefined,
            prevCwd: target.prevCwd ?? undefined,
          }),
          signal: ctl.signal,
        });
        await streamRunInto(targetId, res, ctl);
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") {
          const msg = err instanceof Error ? err.message : String(err);
          patchSession(targetId, (s) => ({ ...s, output: s.output + `\n[Error] ${msg}\n` }));
        }
        patchSession(targetId, (s) =>
          s.abort === ctl ? { ...s, runningCmdId: null, abort: null } : s,
        );
      }
    },
    // streamRunInto is defined below and stable via useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiBase, projectId, activeId, patchSession, flushPending],
  );

  // ─── Free-form streaming: filters the meta sentinel out of display ──
  /**
   * Specialised streamer for `/terminal/run`. Unlike `streamInto`, we need
   * to strip a trailing base64 metadata sentinel from the visible output
   * and apply the `{ cwd, exitCode }` it carries to the session. The
   * sentinel is framed in Record-Separator bytes, so we hold back any
   * partial tail that *could* be the start of a sentinel until we see the
   * closing byte.
   */
  const streamRunInto = useCallback(
    async (targetId: string, res: Response, ctl: AbortController) => {
      try {
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { code?: string; message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let pending = ""; // bytes we've decoded but not yet flushed to `output`
        let meta: RunMeta | null = null;
        const flush = (chunk: string) => {
          if (!chunk) return;
          appendOutput(targetId, chunk);
        };

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });

          // 1. Pull out a complete sentinel, if present. There's only ever
          //    one (emitted at the very end by the server), but we keep
          //    looping defensively in case the server ever sends more.
          for (;;) {
            const { meta: found, rest } = extractMeta(pending);
            if (!found) break;
            meta = found;
            pending = rest;
          }

          // 2. Flush whatever precedes a possibly-incomplete sentinel tail.
          //    If pending ends with a 0x1E that hasn't been closed yet, it
          //    *could* be the start of the sentinel — hold it back so we
          //    don't accidentally render `\x1eSHOGO_TERM_META:...` to the
          //    user if the TCP chunk boundary lands mid-sentinel.
          const tail = pending.lastIndexOf("\u001e");
          if (tail === -1) {
            flush(pending);
            pending = "";
          } else {
            flush(pending.slice(0, tail));
            pending = pending.slice(tail);
          }
        }

        // Drain any final decoder bytes.
        pending += decoder.decode();
        // One last try to pluck a meta sentinel out of the remainder…
        const finalExtract = extractMeta(pending);
        if (finalExtract.meta) {
          meta = finalExtract.meta;
          pending = finalExtract.rest;
        }
        // If what's left *still* looks like an unterminated sentinel, drop
        // it rather than leaking control bytes into the display.
        if (/^\u001eSHOGO_TERM_META:[A-Za-z0-9+/=]*$/.test(pending)) {
          pending = "";
        }
        flush(pending);

        // Make sure any batched chunks hit state before we append the
        // trailing `[exit N]` line — otherwise the exit marker can race
        // ahead of the last few bytes of command output.
        flushPending();
        if (meta?.cwd) {
          patchSession(targetId, (s) =>
            s.cwd === meta!.cwd
              ? s
              : { ...s, prevCwd: s.cwd ?? s.prevCwd, cwd: meta!.cwd ?? s.cwd },
          );
        }
        if (typeof meta?.exitCode === "number" && meta.exitCode !== 0) {
          patchSession(targetId, (s) => ({
            ...s,
            output: s.output + `[exit ${meta!.exitCode}]\n`,
          }));
        }
      } catch (err) {
        flushPending();
        if ((err as { name?: string })?.name === "AbortError") {
          patchSession(targetId, (s) => ({ ...s, output: s.output + "\n[Cancelled]\n" }));
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          patchSession(targetId, (s) => ({ ...s, output: s.output + `\n[Error run] ${msg}\n` }));
        }
      } finally {
        flushPending();
        patchSession(targetId, (s) =>
          s.abort === ctl ? { ...s, runningCmdId: null, abort: null } : s,
        );
      }
    },
    [appendOutput, flushPending, patchSession],
  );

  const stop = useCallback(() => {
    active?.abort?.abort();
  }, [active]);

  const clear = useCallback(() => {
    if (!active) return;
    patchSession(active.id, (s) => ({ ...s, output: "" }));
  }, [active, patchSession]);

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

  // Flat, ordered list of presets the dropdown menu consumes. Grouping info
  // travels alongside so the menu can render section headers.
  const presetGroups = orderedCategories.map((cat) => ({
    category: cat,
    label: CATEGORY_LABEL[cat] ?? cat,
    commands: commands[cat] ?? [],
  }));

  // Clicking anywhere in the empty part of the output should focus the input,
  // the way a real terminal emulator re-focuses on click.
  const focusPrompt = () => promptInputRef.current?.focus();

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <SessionTabs
        sessions={sessions}
        labels={labels}
        activeId={active?.id ?? ""}
        onSelect={setActiveId}
        onClose={closeSession}
        onCloseAll={closeAllSessions}
        onAdd={addSession}
        onStop={stop}
        onClear={clear}
        clearDisabled={!active?.output}
        running={!!active?.runningCmdId}
        presetGroups={presetGroups}
        presetsLoading={loading}
        presetsError={loadError}
        onRetryPresets={() => void loadCommands()}
        onRunPreset={(cmd) => void runCommand(cmd, false)}
        runningPresetId={active?.runningCmdId ?? null}
      />
      <div
        ref={outputRef}
        onClick={focusPrompt}
        className="flex-1 cursor-text overflow-auto bg-[#1e1e1e] px-3 py-2 font-mono text-[12px] leading-[1.5] text-[#d4d4d4]"
      >
        {active?.output && (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono">
            {active.output}
          </pre>
        )}
        {/*
         * Prompt lives inside the scroll region (VS Code / Cursor parity) so
         * it sits flush against the last line of output and scrolls with it.
         * While a command is running we hide the input — the running command
         * owns the bottom of the log, and the user can hit Ctrl+C / Stop.
         */}
        {!active?.runningCmdId && (
          <Prompt
            ref={promptInputRef}
            disabled={!projectId}
            history={active?.history ?? []}
            cwdLabel={formatPromptCwd(active?.cwd ?? null)}
            onRun={(cmd) => void runFreeCommand(cmd)}
            onClear={clear}
          />
        )}
      </div>

      {confirming && (
        <ConfirmDangerous
          command={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void runCommand(confirming, true)}
        />
      )}
    </div>
  );
}

interface PresetGroup {
  category: string;
  label: string;
  commands: PresetCommandDto[];
}

function SessionTabs({
  sessions,
  labels,
  activeId,
  onSelect,
  onClose,
  onCloseAll,
  onAdd,
  onStop,
  onClear,
  clearDisabled,
  running,
  presetGroups,
  presetsLoading,
  presetsError,
  onRetryPresets,
  onRunPreset,
  runningPresetId,
}: {
  sessions: Session[];
  labels: Map<string, string>;
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseAll: () => void;
  onAdd: () => void;
  onStop: () => void;
  onClear: () => void;
  clearDisabled: boolean;
  running: boolean;
  presetGroups: PresetGroup[];
  presetsLoading: boolean;
  presetsError: string | null;
  onRetryPresets: () => void;
  onRunPreset: (cmd: PresetCommandDto) => void;
  runningPresetId: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="relative flex shrink-0 items-center justify-between border-b border-[#2a2a2a] bg-[#1e1e1e] pr-2">
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <div
              key={s.id}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(s.id);
                }
              }}
              className={`group flex shrink-0 cursor-pointer items-center gap-1 border-r border-[#2a2a2a] px-2 py-[6px] text-[11px] ${
                active
                  ? "bg-[#1e1e1e] text-white"
                  : "bg-[#252526] text-[#858585] hover:bg-[#2a2a2a] hover:text-white"
              }`}
            >
              {s.runningCmdId ? (
                <Loader2 size={10} className="animate-spin text-[#0078d4]" />
              ) : (
                <span className="inline-block h-2 w-2 rounded-full bg-[#4ec9b0]/60" />
              )}
              <span className="max-w-[120px] truncate">{labels.get(s.id) ?? s.id}</span>
              <button
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.id);
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
        <button
          onClick={onAdd}
          title="New Terminal  (⌘⇧`)"
          className="flex shrink-0 items-center gap-1 px-2 py-[6px] text-[11px] text-[#858585] hover:bg-[#2a2a2a] hover:text-white"
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          title="Terminal actions & presets"
          aria-label="Terminal actions"
          aria-expanded={menuOpen}
          className="flex shrink-0 items-center gap-1 px-1 py-[6px] text-[#858585] hover:bg-[#2a2a2a] hover:text-white"
        >
          <ChevronDown size={12} />
        </button>
      </div>
      <div className="flex items-center gap-1">
        {running && (
          <button
            onClick={onStop}
            title="Stop running command  (Ctrl+C)"
            className="flex items-center gap-1 rounded px-2 py-[2px] text-[11px] text-[#f48771] hover:bg-[#ffffff1a]"
          >
            <Square size={10} /> Stop
          </button>
        )}
        <button
          onClick={onClear}
          disabled={clearDisabled}
          title="Clear output"
          className="flex items-center gap-1 rounded px-2 py-[2px] text-[11px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white disabled:opacity-40"
        >
          <Trash2 size={10} /> Clear
        </button>
      </div>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          {/*
           * Opens *upward* from the tab strip. The Terminal always lives at
           * the bottom of the IDE, so there's more room above than below —
           * this mirrors VS Code's own Terminal kebab menu and avoids ever
           * being clipped by the viewport bottom. `bottom-full` anchors to
           * the top edge of SessionTabs; `mb-1` gives a 4px visual gap.
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
                onClose(activeId);
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

            {/*
             * Preset commands: curated workflows users can trigger without
             * typing. Cursor hides these behind a palette — we keep them one
             * hop away from the chevron so discovery is easy but they don't
             * eat permanent screen real-estate.
             */}
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
                  {group.commands.map((cmd) => {
                    const isRunning = runningPresetId === cmd.id;
                    return (
                      <MenuItem
                        key={cmd.id}
                        disabled={!!runningPresetId && !isRunning}
                        onClick={() => {
                          setMenuOpen(false);
                          onRunPreset(cmd);
                        }}
                        title={cmd.description}
                      >
                        <span className="truncate">{cmd.label}</span>
                        {isRunning && (
                          <Loader2 size={11} className="ml-auto shrink-0 animate-spin text-[#0078d4]" />
                        )}
                        {!isRunning && cmd.dangerous && (
                          <AlertTriangle size={11} className="ml-auto shrink-0 text-[#dcdcaa]" />
                        )}
                      </MenuItem>
                    );
                  })}
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

/**
 * Inline prompt rendered at the bottom of the output log. Behaves like a
 * real shell:
 *   - Enter submits
 *   - ↑ / ↓ walks per-session history
 *   - Caller owns focus via the forwarded ref
 *
 * We purposely drop the "running" state here — while a command streams, the
 * parent hides this component so the log owns the bottom of the view, and
 * Ctrl+C / Stop buttons live on the header.
 */
const Prompt = React.forwardRef<
  HTMLInputElement,
  {
    disabled: boolean;
    history: string[];
    cwdLabel: string;
    onRun: (cmd: string) => void;
    onClear: () => void;
  }
>(function Prompt({ disabled, history, cwdLabel, onRun, onClear }, ref) {
  const [value, setValue] = useState("");
  const [histIdx, setHistIdx] = useState<number | null>(null);

  // Reset history cursor when the underlying history changes (e.g. after
  // submitting a new command).
  useEffect(() => {
    setHistIdx(null);
  }, [history]);

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        const v = value.trim();
        if (!v) return;
        onRun(v);
        setValue("");
        setHistIdx(null);
      }}
    >
      {cwdLabel && (
        <span className="shrink-0 select-none text-[#6a9955]">{cwdLabel}</span>
      )}
      <span className="shrink-0 select-none text-[#4ec9b0]">$</span>
      <input
        ref={ref}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setHistIdx(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            if (history.length === 0) return;
            e.preventDefault();
            const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
            setHistIdx(next);
            setValue(history[next] ?? "");
          } else if (e.key === "ArrowDown") {
            if (history.length === 0 || histIdx === null) return;
            e.preventDefault();
            const next = histIdx + 1;
            if (next >= history.length) {
              setHistIdx(null);
              setValue("");
            } else {
              setHistIdx(next);
              setValue(history[next] ?? "");
            }
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
            // Ctrl+L / ⌘K parity with a real shell: clear the buffer but
            // preserve whatever the user was typing. We swallow the event so
            // the browser doesn't focus the URL bar on Ctrl+L.
            e.preventDefault();
            onClear();
          } else if (e.ctrlKey && e.key.toLowerCase() === "c" && !value) {
            // Empty-line Ctrl+C in a real shell just reprints the prompt.
            // With text selected we let the browser handle copy normally.
            const sel = window.getSelection?.()?.toString();
            if (!sel) {
              e.preventDefault();
              setValue("");
              setHistIdx(null);
            }
          } else if (e.ctrlKey && e.key.toLowerCase() === "u") {
            // Ctrl+U: kill line (shell parity).
            e.preventDefault();
            setValue("");
            setHistIdx(null);
          }
        }}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="no-focus-ring flex-1 border-0 bg-transparent p-0 font-mono text-[12px] text-[#d4d4d4] outline-none focus:ring-0 disabled:opacity-50"
      />
    </form>
  );
});

function ConfirmDangerous({
  command,
  onCancel,
  onConfirm,
}: {
  command: PresetCommandDto;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[360px] rounded-lg border border-[#2a2a2a] bg-[#252526] p-4 shadow-2xl">
        <div className="mb-2 flex items-center gap-2 text-[#dcdcaa]">
          <AlertTriangle size={14} />
          <span className="text-[13px] font-semibold">This is a destructive command</span>
        </div>
        <div className="mb-1 text-[13px] text-[#cccccc]">{command.label}</div>
        <div className="mb-4 text-[12px] leading-relaxed text-[#858585]">
          {command.description}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1 text-[12px] text-[#cccccc] hover:bg-[#ffffff1a]"
          >
            Cancel
          </button>
          <button
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
