// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { API_URL } from "../../../../../../lib/api";
import { PtyClient, toTerminalPtyWsUrl } from "./pty-client";

export interface PtyTerminalHandle {
  clear: () => void;
  interrupt: () => void;
}

export const PtyTerminal = forwardRef<PtyTerminalHandle, {
  projectId: string;
  sessionKey: string;
  cwd?: string | null;
  onFallback: (reason: string) => void;
}>(function PtyTerminal({ projectId, sessionKey, cwd, onFallback }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const clientRef = useRef<PtyClient | null>(null);
  const outputQueueRef = useRef("");
  const outputFlushRef = useRef<number | null>(null);
  const fallbackRef = useRef(onFallback);
  fallbackRef.current = onFallback;

  useImperativeHandle(ref, () => ({
    clear() {
      termRef.current?.clear?.();
    },
    interrupt() {
      clientRef.current?.signal("SIGINT");
    },
  }), []);

  useEffect(() => {
    let disposed = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    async function boot() {
      try {
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
        ]);
        if (disposed || !hostRef.current) return;
        ensureXtermRuntimeStyles();

        const term = new Terminal({
          cursorBlink: true,
          convertEol: true,
          fontFamily: "Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
          fontSize: 12,
          lineHeight: 1.25,
          scrollback: 1000,
          theme: {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
            cursor: "#d4d4d4",
            selectionBackground: "#264f78",
          },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());
        term.open(hostRef.current);
        termRef.current = term;
        fitRef.current = fit;
        fit.fit();

        const storageKey = `shogo:pty:${projectId}:${sessionKey}`;
        const existingSessionId = window.sessionStorage.getItem(storageKey) ?? undefined;
        const client = new PtyClient({
          url: toTerminalPtyWsUrl(API_URL, projectId),
          sessionId: existingSessionId,
          cols: term.cols || 80,
          rows: term.rows || 24,
          cwd,
        });
        clientRef.current = client;
        client.onReady((ready) => {
          window.sessionStorage.setItem(storageKey, ready.sessionId);
        });
        const writeQueued = (chunk: string) => {
          outputQueueRef.current += chunk;
          if (outputQueueRef.current.length > 256_000) {
            outputQueueRef.current = outputQueueRef.current.slice(-256_000);
            term.writeln("\r\n[PTY] output truncated because the browser fell behind\r\n");
          }
          if (outputFlushRef.current !== null) return;
          outputFlushRef.current = requestAnimationFrame(() => {
            outputFlushRef.current = null;
            const next = outputQueueRef.current;
            outputQueueRef.current = "";
            if (next) term.write(next);
          });
        };
        client.onData(writeQueued);
        client.onError((message) => {
          term.writeln(`\r\n[PTY] ${message}`);
          window.sessionStorage.removeItem(storageKey);
          fallbackRef.current(message);
        });
        client.onExit((exit) => {
          const code = exit.exitCode === null ? "unknown" : String(exit.exitCode);
          window.sessionStorage.removeItem(storageKey);
          term.writeln(`\r\n[Process exited with code ${code}]`);
        });
        term.onData((data) => client.write(data));
        client.connect();

        const resize = () => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            fit.fit();
            client.resize(term.cols || 80, term.rows || 24);
          }, 50);
        };
        window.addEventListener("resize", resize);
        const observer = new ResizeObserver(resize);
        observer.observe(hostRef.current);
        return () => {
          window.removeEventListener("resize", resize);
          observer.disconnect();
        };
      } catch (err) {
        fallbackRef.current(err instanceof Error ? err.message : String(err));
      }
    }

    let cleanup: void | (() => void);
    void boot().then((fn) => {
      cleanup = fn;
      if (disposed && cleanup) cleanup();
    });
    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      if (outputFlushRef.current !== null) cancelAnimationFrame(outputFlushRef.current);
      outputFlushRef.current = null;
      outputQueueRef.current = "";
      cleanup?.();
      clientRef.current?.close();
      clientRef.current = null;
      termRef.current?.dispose?.();
      termRef.current = null;
    };
  }, [projectId, sessionKey, cwd]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden bg-[#1e1e1e]" />;
});

function ensureXtermRuntimeStyles(): void {
  if (typeof document === "undefined" || document.getElementById("shogo-xterm-runtime-styles")) return;
  const style = document.createElement("style");
  style.id = "shogo-xterm-runtime-styles";
  style.textContent = `
.xterm {
  position: relative;
  user-select: none;
  -ms-user-select: none;
}
.xterm.focus,
.xterm:focus {
  outline: none;
}
.xterm .xterm-helpers {
  position: absolute;
  top: 0;
  z-index: 5;
}
.xterm .xterm-helper-textarea {
  position: absolute;
  left: -9999em;
  top: 0;
  width: 0;
  height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  opacity: 0;
  resize: none;
  overflow: hidden;
  white-space: nowrap;
}
.xterm .composition-view {
  display: none;
  position: absolute;
  white-space: nowrap;
  z-index: 1;
}
.xterm .xterm-viewport {
  position: absolute;
  inset: 0;
  overflow-y: scroll;
  cursor: default;
}
.xterm .xterm-screen {
  position: relative;
}
.xterm .xterm-screen canvas {
  position: absolute;
  left: 0;
  top: 0;
}
.xterm .xterm-scroll-area {
  visibility: hidden;
}
.xterm-char-measure-element {
  position: absolute;
  left: -9999em;
  top: 0;
  display: inline-block;
  visibility: hidden;
}
.xterm .xterm-accessibility,
.xterm .xterm-message {
  position: absolute;
  inset: 0;
  color: transparent;
  pointer-events: none;
}
`;
  document.head.appendChild(style);
}
