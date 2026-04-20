import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { api } from "./workspace/apiBase";

/**
 * Real shell session rendered with xterm.js. One session per mounted instance.
 *  - POST  /api/term/spawn          → session id
 *  - GET   /api/term/:id/stream     → SSE stream of base64 output chunks
 *  - POST  /api/term/:id/stdin      → base64-encoded bytes to the shell
 *  - POST  /api/term/:id/kill       → cleanup on unmount
 */
export function Terminal({ visible }: { visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new XTerm({
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
      scrollback: 2000,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
        black: "#000000",
        red: "#f48771",
        green: "#4ec9b0",
        yellow: "#dcdcaa",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#9cdcfe",
        white: "#d4d4d4",
        brightBlack: "#666666",
        brightRed: "#f48771",
        brightGreen: "#b5cea8",
        brightYellow: "#ffd75e",
        brightBlue: "#75beff",
        brightMagenta: "#d7ba7d",
        brightCyan: "#9cdcfe",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    let cancelled = false;

    const boot = async () => {
      try {
        const res = await fetch(api("/api/term/spawn"), { method: "POST" });
        const { id, error } = (await res.json()) as { id?: string; error?: string };
        if (error || !id) throw new Error(error ?? "spawn failed");
        if (cancelled) {
          void fetch(api(`/api/term/${id}/kill`), { method: "POST" });
          return;
        }
        sessionIdRef.current = id;

        const es = new EventSource(api(`/api/term/${id}/stream`));
        esRef.current = es;
        es.addEventListener("data", (ev) => {
          const payload = (ev as MessageEvent<string>).data;
          try {
            const bytes = atob(payload);
            term.write(bytes);
          } catch { /* ignore */ }
        });
        es.onerror = () => {
          // silently retry via browser; nothing to do here
        };

        // Line-buffered input — build a line locally, send on Enter.
        // Ctrl-C interrupts the running command; backspace edits the line.
        let lineBuf = "";
        term.onData((data) => {
          if (!sessionIdRef.current) return;
          for (const ch of data) {
            const code = ch.charCodeAt(0);
            if (ch === "\r" || ch === "\n") {
              term.write("\r\n");
              void fetch(api(`/api/term/${sessionIdRef.current}/exec`), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ line: lineBuf }),
              });
              lineBuf = "";
            } else if (code === 127 || ch === "\b") {
              if (lineBuf.length > 0) {
                lineBuf = lineBuf.slice(0, -1);
                term.write("\b \b");
              }
            } else if (code === 3) {
              term.write("^C\r\n");
              void fetch(api(`/api/term/${sessionIdRef.current}/signal`), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ signal: "SIGINT" }),
              });
              lineBuf = "";
            } else if (code >= 32 && code !== 127) {
              lineBuf += ch;
              term.write(ch);
            }
          }
        });

        setTimeout(() => {
          try { fit.fit(); } catch { /* ignore */ }
        }, 50);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        term.write(`\r\n\x1b[31mTerminal failed to start: ${msg}\x1b[0m\r\n`);
      }
    };
    void boot();

    const onResize = () => {
      try { fit.fit(); } catch { /* ignore */ }
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      esRef.current?.close();
      if (sessionIdRef.current) {
        void fetch(api(`/api/term/${sessionIdRef.current}/kill`), { method: "POST" });
      }
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (visible) {
      setTimeout(() => {
        try { fitRef.current?.fit(); termRef.current?.focus(); } catch { /* ignore */ }
      }, 50);
    }
  }, [visible]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full overflow-hidden bg-[#1e1e1e] px-2 pt-1"
      onClick={() => termRef.current?.focus()}
    />
  );
}
