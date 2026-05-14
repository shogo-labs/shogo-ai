import { useEffect, useMemo, useState } from "react";
import {
  FileText,
  Music,
  Video,
  Type as TypeIcon,
  AlertTriangle,
  ExternalLink,
} from "lucide-react-native";

/**
 * Lightweight previewers for non-text non-image binary files. Each component
 * receives a URL (blob: for local workspaces, http: for agent workspaces)
 * already resolved by Workbench, plus the file name + path for chrome.
 *
 * These previews are read-only — none of them write back to disk. The URL's
 * lifetime is owned by Workbench (it revokes blob: URLs on tab close).
 */

const PDF_EXTS = new Set(["pdf"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "mkv", "avi", "ogv"]);
const FONT_EXTS = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

function extOf(path: string): string {
  return path.toLowerCase().split(".").pop() ?? "";
}
export function isPdfPath(path: string): boolean { return PDF_EXTS.has(extOf(path)); }
export function isAudioPath(path: string): boolean { return AUDIO_EXTS.has(extOf(path)); }
export function isVideoPath(path: string): boolean { return VIDEO_EXTS.has(extOf(path)); }
export function isFontPath(path: string): boolean { return FONT_EXTS.has(extOf(path)); }

// ─── PDF ────────────────────────────────────────────────────────────────
export function PdfPreview({ url, name }: { url: string; name: string; path: string }) {
  return (
    <div className="flex h-full flex-col">
      <ChromeBar icon={<FileText size={13} className="shrink-0 text-[color:var(--ide-accent-file-icon)]" />}
                 name={name} url={url} extra="PDF · browser-rendered" />
      <iframe
        title={name}
        src={url}
        className="flex-1 w-full bg-[color:var(--ide-bg)]"
        // sandbox is intentionally permissive enough for the browser's built-in
        // PDF viewer (Chromium PDFium / Firefox PDF.js) to run; we don't grant
        // top-navigation or popup escapes.
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
      />
    </div>
  );
}

// ─── Audio ──────────────────────────────────────────────────────────────
export function AudioPreview({ url, name }: { url: string; name: string; path: string }) {
  return (
    <div className="flex h-full flex-col">
      <ChromeBar icon={<Music size={13} className="shrink-0 text-[color:var(--ide-accent-file-icon)]" />}
                 name={name} url={url} extra="audio" />
      <div className="flex flex-1 items-center justify-center bg-[color:var(--ide-bg)]">
        <audio
          src={url}
          controls
          className="w-[min(640px,90%)]"
          onError={() => { /* the browser shows its own UI; we don't need to crash */ }}
        />
      </div>
    </div>
  );
}

// ─── Video ──────────────────────────────────────────────────────────────
export function VideoPreview({ url, name }: { url: string; name: string; path: string }) {
  return (
    <div className="flex h-full flex-col">
      <ChromeBar icon={<Video size={13} className="shrink-0 text-[color:var(--ide-accent-file-icon)]" />}
                 name={name} url={url} extra="video" />
      <div className="flex flex-1 items-center justify-center overflow-hidden bg-black">
        <video
          src={url}
          controls
          className="max-h-full max-w-full"
        />
      </div>
    </div>
  );
}

// ─── Font ───────────────────────────────────────────────────────────────
const FONT_FORMAT: Record<string, string> = {
  woff: "woff",
  woff2: "woff2",
  ttf: "truetype",
  otf: "opentype",
  eot: "embedded-opentype",
};
const SPECIMEN_SIZES = [12, 16, 24, 36, 56, 96];
const SPECIMEN_TEXT =
  "The quick brown fox jumps over the lazy dog. 0123456789 !? &@#";

export function FontPreview({ url, name, path }: { url: string; name: string; path: string }) {
  const ext = extOf(path);
  const format = FONT_FORMAT[ext] ?? "opentype";
  // Pick a unique family per tab so two different .ttf files don't collide
  // in @font-face — the URL is unique enough.
  const family = useMemo(
    () => `ide-font-${encodeURIComponent(url).replace(/%/g, "_").slice(-32)}`,
    [url],
  );
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState(SPECIMEN_TEXT);

  useEffect(() => {
    let cancelled = false;
    if (typeof document === "undefined" || !("fonts" in document)) {
      setError("Font preview not supported in this browser.");
      return;
    }
    const ff = new FontFace(family, `url(${JSON.stringify(url)}) format('${format}')`);
    ff.load()
      .then(() => {
        if (cancelled) return;
        document.fonts.add(ff);
      })
      .catch(() => {
        if (!cancelled) setError(`Could not load ${name}`);
      });
    return () => {
      cancelled = true;
      try { document.fonts.delete(ff); } catch { /* ignore */ }
    };
  }, [url, family, format, name]);

  return (
    <div className="flex h-full flex-col">
      <ChromeBar icon={<TypeIcon size={13} className="shrink-0 text-[color:var(--ide-accent-file-icon)]" />}
                 name={name} url={url} extra={`font · ${ext.toUpperCase()}`} />
      <div className="flex items-center gap-2 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-surface)] px-3 py-1 text-[11px] text-[color:var(--ide-muted)]">
        <span>Sample:</span>
        <input
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          className="flex-1 rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-bg)] px-2 py-0.5 text-[color:var(--ide-text)] outline-none focus:border-[color:var(--ide-accent)]"
        />
      </div>
      <div className="flex-1 overflow-auto bg-[color:var(--ide-bg)] p-6">
        {error ? (
          <div className="flex items-center gap-2 text-[color:var(--ide-error)]">
            <AlertTriangle size={14} />
            <span className="text-[12px]">{error}</span>
          </div>
        ) : (
          <div className="space-y-4">
            {SPECIMEN_SIZES.map((size) => (
              <div key={size}>
                <div className="text-[10px] uppercase tracking-wide text-[color:var(--ide-muted)]">
                  {size}px
                </div>
                <div
                  style={{ fontFamily: `"${family}", system-ui`, fontSize: size }}
                  className="text-[color:var(--ide-text)] break-words"
                >
                  {sample || SPECIMEN_TEXT}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shared chrome bar ──────────────────────────────────────────────────
function ChromeBar({
  icon,
  name,
  url,
  extra,
}: {
  icon: React.ReactNode;
  name: string;
  url: string;
  extra?: string;
}) {
  return (
    <div className="flex h-8 items-center justify-between gap-2 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-surface)] px-3 text-[12px] text-[color:var(--ide-muted)]">
      <div className="flex items-center gap-2 min-w-0">
        {icon}
        <span className="truncate text-[color:var(--ide-text)]">{name}</span>
        {extra && <span className="shrink-0">· {extra}</span>}
      </div>
      <button
        title="Open in new tab"
        onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
        className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
      >
        <ExternalLink size={12} />
      </button>
    </div>
  );
}
